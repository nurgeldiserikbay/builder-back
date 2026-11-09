import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { ImageRejectedError, MAX_EDGE, detectImageType, inlineImages, processImage } from './image-processing.js';
import { scanRequired } from '../security/clamav.js';
import { changedKeys, contentImageIds, defaultDesign, mergeProposal, normalizeContent, templateContent, type Brief, type ContentArtifact } from '../journey/artifacts.js';
import { checkSite, pageCsp, renderSite } from '../journey/site-renderer.js';

const brief: Brief = {
  businessName: 'Студия', whatYouDo: 'Делаем ремонт', audience: 'Жители города', city: 'Алматы', mainAction: 'call', tone: 'friendly',
  phone: '+77001234567', messenger: null, email: null, address: null,
} as Brief;
const photoId = '11111111-2222-4333-8444-555555555555';

async function jpegWithExif(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } })
    .withMetadata({ exif: { IFD0: { Artist: 'Secret Person', Copyright: 'GPS-hidden' } } }).jpeg().toBuffer();
}

describe('image processing', () => {
  it('detects supported types by content, not by name', async () => {
    assert.equal(detectImageType(await jpegWithExif(10, 10)), 'jpeg');
    assert.equal(detectImageType(await sharp({ create: { width: 4, height: 4, channels: 4, background: '#fff' } }).png().toBuffer()), 'png');
    assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.equal(detectImageType(Buffer.from('GIF89a......')), null);
  });
  it('re-encodes to WebP, limits the size and strips metadata', async () => {
    const result = await processImage(await jpegWithExif(3000, 2000));
    assert.equal(detectImageType(result.data), 'webp');
    assert.equal(result.width, MAX_EDGE);
    assert.equal(result.height, Math.round(2000 * MAX_EDGE / 3000));
    const meta = await sharp(result.data).metadata();
    assert.equal(meta.exif, undefined);
    assert.ok(!result.data.includes(Buffer.from('Secret Person')));
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
  });
  it('rejects files that are not images', async () => {
    await assert.rejects(processImage(Buffer.from('not an image at all')), (error: unknown) => error instanceof ImageRejectedError);
    const truncated = (await jpegWithExif(400, 400)).subarray(0, 200);
    await assert.rejects(processImage(truncated), (error: unknown) => error instanceof ImageRejectedError);
  });
  it('inlines only photos that exist', async () => {
    const html = `<img src="/img/${photoId}.webp"><img src="/img/99999999-2222-4333-8444-555555555555.webp">`;
    const out = await inlineImages(html, async (ids) => new Map(ids.filter((id) => id === photoId).map((id) => [id, Buffer.from('abc')])));
    assert.ok(out.includes('src="data:image/webp;base64,YWJj"'));
    assert.ok(out.includes('/img/99999999-2222-4333-8444-555555555555.webp'));
  });
  it('requires malware scanning unless explicitly disabled outside production', () => {
    assert.equal(scanRequired({}), true);
    assert.equal(scanRequired({ UPLOAD_MALWARE_SCAN: 'disabled', NODE_ENV: 'development' }), false);
    assert.equal(scanRequired({ UPLOAD_MALWARE_SCAN: 'disabled', NODE_ENV: 'production' }), true);
  });
});

describe('photos in content and site', () => {
  const withPhoto = (): ContentArtifact => {
    const base = templateContent(brief, null);
    return { ...base, sections: base.sections.map((section) => (section.key === 'hero' ? { ...section, imageId: photoId } : section)) };
  };
  it('accepts only photo ids, not URLs', () => {
    const content = withPhoto();
    assert.deepEqual(contentImageIds(normalizeContent(content)), [photoId]);
    const bad = { ...content, sections: content.sections.map((section) => (section.key === 'hero' ? { ...section, imageId: 'https://evil.example/x.png' } : section)) };
    assert.throws(() => normalizeContent(bad));
  });
  it('does not treat a photo choice or an older version without photos as a text edit', () => {
    const base = templateContent(brief, null);
    const legacy = JSON.parse(JSON.stringify({ ...base, sections: base.sections.map(({ imageId: _photo, ...rest }) => rest) }));
    assert.deepEqual(changedKeys('content', legacy, withPhoto()), []);
  });
  it('keeps chosen photos when AI rewrites texts', () => {
    const base = withPhoto();
    const proposal = { ...base, sections: base.sections.map((section) => ({ ...section, text: 'ИИ', imageId: null })) };
    const merged = mergeProposal('content', base, proposal, [], null) as ContentArtifact;
    assert.equal(merged.sections.find((section) => section.key === 'hero')?.imageId, photoId);
    const targeted = mergeProposal('content', base, { ...base, sections: base.sections.map((section) => ({ ...section, text: 'Новый', imageId: null })) }, [], 'hero') as ContentArtifact;
    assert.equal(targeted.sections.find((section) => section.key === 'hero')?.imageId, photoId);
  });
  it('renders the photo with its description and allows same-origin images', () => {
    const content = withPhoto();
    const input = { brief, offer: null, content, design: defaultDesign, locale: 'ru', draft: false, images: { [photoId]: { alt: 'Мастер за работой', width: 1600, height: 1067 } } };
    const html = renderSite(input);
    assert.ok(html.includes(`src="/img/${photoId}.webp" alt="Мастер за работой" width="1600" height="1067"`));
    assert.ok(pageCsp(false).includes("img-src 'self' data:"));
    assert.ok(!/<script/i.test(html));
    assert.equal(checkSite(input).find((check) => check.id === 'photos')?.status, 'passed');
  });
  it('flags deleted photos and missing descriptions', () => {
    const content = withPhoto();
    const missing = checkSite({ brief, offer: null, content, design: defaultDesign, locale: 'ru', draft: false, images: {} });
    assert.equal(missing.find((check) => check.id === 'photos')?.status, 'failed');
    const noAlt = checkSite({ brief, offer: null, content, design: defaultDesign, locale: 'ru', draft: false, images: { [photoId]: { alt: ' ', width: 10, height: 10 } } });
    assert.notEqual(noAlt.find((check) => check.id === 'photo-alt')?.status, 'passed');
    assert.ok(!renderSite({ brief, offer: null, content, design: defaultDesign, locale: 'ru', draft: false, images: {} }).includes('/img/'));
  });
});
