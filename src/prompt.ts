/** Terminal prompts. The streams are parameters so tests can drive them. */

export interface SecretInput extends NodeJS.EventEmitter {
    isTTY?: boolean;
    setRawMode?(mode: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    setEncoding(encoding: BufferEncoding): unknown;
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
}

/**
 * Reads a secret without echoing it. Piped input (not a TTY) is read to the
 * end. Enter / Ctrl-D finish, Ctrl-C cancels; either way the raw mode, the
 * listener and the paused stream are restored, so the process can exit.
 */
export async function readSecret(prompt: string, input: SecretInput, output: { write(text: string): unknown; }): Promise<string> {
    if (!input.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return Buffer.concat(chunks).toString('utf8').trim();
    }
    output.write(prompt);
    return new Promise((resolve, reject) => {
        let value = '';
        const finish = () => {
            input.setRawMode?.(false);
            input.off('data', onData);
            input.pause();
            output.write('\n');
        };
        const onData = (data: string | Buffer) => {
            // A paste arrives as one chunk: handle it character by character.
            for (const char of String(data)) {
                if (char === '\r' || char === '\n' || char === '\u0004') {
                    finish();
                    resolve(value.trim());
                    return;
                }
                if (char === '\u0003') {
                    finish();
                    reject(new Error('Cancelled'));
                    return;
                }
                if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
                else value += char;
            }
        };
        input.setRawMode?.(true);
        input.resume();
        input.setEncoding('utf8');
        input.on('data', onData);
    });
}
