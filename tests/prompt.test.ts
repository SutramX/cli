import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readSecret } from '../src/prompt.js';

/** A stand-in for a TTY stdin that records raw mode and paused state. */
class FakeTty extends EventEmitter {
    isTTY = true;
    raw = false;
    paused = true;
    setRawMode(mode: boolean) { this.raw = mode; }
    resume() { this.paused = false; }
    pause() { this.paused = true; }
    setEncoding() {}
    async *[Symbol.asyncIterator]() {}
}

const sink = { text: '', write(chunk: string) { this.text += chunk; } };

test('readSecret: Ctrl-C rejects and restores the terminal (no listener left, stdin paused)', async () => {
    const input = new FakeTty();
    const pending = readSecret('Key: ', input, sink);
    input.emit('data', 'sk_');
    input.emit('data', '\u0003');
    await assert.rejects(pending, /Cancelled/);
    assert.equal(input.listenerCount('data'), 0, 'a leftover data listener keeps the process alive');
    assert.equal(input.paused, true);
    assert.equal(input.raw, false);
});

test('readSecret: Enter resolves the typed value (backspace works, a pasted chunk with newline too)', async () => {
    const input = new FakeTty();
    const typed = readSecret('Key: ', input, sink);
    for (const char of ['s', 'k', 'x', '\u007f', '_', '1', '\r']) input.emit('data', char);
    assert.equal(await typed, 'sk_1');
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.paused, true);

    const pasted = readSecret('Key: ', input, sink);
    input.emit('data', 'sk_pasted\r');
    assert.equal(await pasted, 'sk_pasted');
    assert.ok(!sink.text.includes('sk_'), 'the secret is never echoed');
});
