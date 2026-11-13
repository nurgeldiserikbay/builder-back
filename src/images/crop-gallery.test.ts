import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { cropBox, cropImage, processImage } from './image-processing.js';
import { contentImageIds, mergeProposal, normalizeContent, templateContent, changedKeys, type Brief } from '../journey/artifacts.js';
import { checkSite, renderSite } from '../journey/site-renderer.js';
import { auditSite } from '../quality/site-audit.js';

const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const brief: Brief = { businessName: 'Барбер', whatYouDo: 'Стрижки и бороды', audience: 'Мужчины', city: null, mainAction: 'call', phone: '+7 701 000 00 00', messenger: null, email: null, address: null, tone: 'friendly' };
const design = { palette: 'forest', font: 'modern', corners: 'rounded' as const, heroLayout: 'centered' as const };

describe('photo crop', () => {
  it('checks the rectangle and cuts a re-encoded copy', async () => {
    assert.equal(cropBox({ x: 0.5, y: 0, width: 0.6, height: 1 }, { width: 1000, height: 800 }), 'CROP_INVALID');
    assert.equal(cropBox({ x: 0, y: 0, width: 0.01, height: 1 }, { width: 1000, height: 800 }), 'CROP_TOO_SMALL');
    assert.equal(cropBox({ x: '0', y: 0, width: 1, height: 1 }, { width: 1000, height: 800 }), 'CROP_INVALID');
    assert.deepEqual(cropBox({ x: 0.25, y: 0, width: 0.5, height: 1 }, { width: 1000, height: 800 }), { left: 250, top: 0, width: 500, height: 800 });
    const original = await processImage(await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#a33' } }).jpeg().toBuffer());
    const square = await cropImage(original.data, cropBox({ x: 0.1, y: 0, width: 0.8, height: 1 }, original) as never);
    assert.deepEqual([square.width, square.height], [800, 800]);
    assert.notEqual(square.sha256, original.sha256);
  });
});

describe('photo gallery in a section', () => {
  it('keeps the gallery through normalization and AI rewrites, counts its photos and renders a grid', () => {
    const content = templateContent(brief, null);
    const withGallery = normalizeContent({ ...content, sections: content.sections.map((section, index) => (index === 1 ? { ...section, gallery: [a, b] } : section)) });
    assert.deepEqual(withGallery.sections[1]!.gallery, [a, b]);
    assert.equal('gallery' in withGallery.sections[0]!, false, 'no empty gallery field');
    assert.throws(() => normalizeContent({ ...content, sections: [{ ...content.sections[0]!, gallery: [a, a] }] }), /FIELD_INVALID/);
    assert.throws(() => normalizeContent({ ...content, sections: [{ ...content.sections[0]!, gallery: Array(13).fill(a) }] }), /FIELD_INVALID/);
    assert.deepEqual(contentImageIds(withGallery).sort(), [a, b]);
    // The AI never sends photos: a full rewrite and a one-section rewrite keep them.
    const rewritten = mergeProposal('content', withGallery, content, [], null) as typeof withGallery;
    assert.deepEqual(rewritten.sections[1]!.gallery, [a, b]);
    const one = mergeProposal('content', withGallery, content, [], withGallery.sections[1]!.key) as typeof withGallery;
    assert.deepEqual(one.sections[1]!.gallery, [a, b]);
    // Changing photos does not lock the section's text.
    assert.deepEqual(changedKeys('content', content, withGallery), []);
    const images = { [a]: { alt: 'Стрижка', width: 800, height: 800 }, [b]: { alt: '', width: 800, height: 600 } };
    const html = renderSite({ brief, offer: null, content: withGallery, design, locale: 'ru', draft: false, images });
    assert.match(html, /<ul class="gallery"><li><img src="\/img\/1{8}-1{4}-41{3}-81{3}-1{12}\.webp" alt="Стрижка"/);
    const checks = checkSite({ brief, offer: null, content: withGallery, design, locale: 'ru', draft: false, images });
    assert.equal(checks.find((check) => check.id === 'photo-alt')?.status, 'warning');
    // The grid passes the release gate rules: sizes and descriptions set, nothing external.
    assert.deepEqual(auditSite({ pages: [{ path: '/', html }], imageBytes: { [a]: 50_000, [b]: 50_000 } }).findings.filter((finding) => finding.severity !== 'low'), []);
  });
});
