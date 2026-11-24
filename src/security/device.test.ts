import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice, ipHint } from './device.js';

test('devices are named by browser and system', () => {
  assert.equal(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'), 'Chrome · macOS');
  assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari · iPhone');
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0'), 'Edge · Windows');
  assert.equal(describeDevice('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Telegram-Android/11'), 'Telegram');
  assert.equal(describeDevice(null), 'Неизвестное устройство');
});

test('the network hint never shows the full address', () => {
  assert.equal(ipHint('85.117.42.10'), '85.117.x.x');
  assert.equal(ipHint('::ffff:85.117.42.10'), '85.117.x.x');
  assert.equal(ipHint('2a02:6b8:0:1::5'), '2a02:6b8::');
  assert.equal(ipHint('127.0.0.1'), null);
  assert.equal(ipHint(''), null);
});
