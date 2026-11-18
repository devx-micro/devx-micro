// A stand-in sidecar for the client's tests: one JSON envelope back per request line, with a few
// operations that misbehave on purpose.
const { createInterface } = require('node:readline');

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.operation === 'crash') process.exit(3);
  if (request.operation === 'slow') {
    setTimeout(() => reply({ status: 'success', data: 'slow' }), 50);
    return;
  }
  reply({ status: 'success', data: request });
});
function reply(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
