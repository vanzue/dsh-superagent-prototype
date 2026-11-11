import { expect, it } from 'vitest'
import { AcpClient } from '../src/infra/acp.ts'

const peer = `
let buffer = '';
process.stdin.setEncoding('utf8');
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf('\\n'); if (at < 0) return;
    const m = JSON.parse(buffer.slice(0,at)); buffer = buffer.slice(at+1);
    if (m.method === 'initialize') send({id:m.id,result:{ok:true}});
    if (m.method === 'permission') send({id:'approval',method:'session/request_permission',params:{options:[{kind:'allow_once',optionId:'once'}]}});
    if (m.id === 'approval') send({method:'approval',params:m.result});
    if (m.method === 'exit') process.exit(0);
    if (m.method === 'invalid') process.stdout.write('not-json\\n');
  }
});
`
function connect(permission = true) {
  const events: unknown[] = []
  const client = new AcpClient({ argv: [process.execPath, '-e', peer], cwd: process.cwd(), env: process.env,
    notification: event => events.push(event), permission: () => permission })
  return { client, events }
}
it('correlates responses and refuses permissions after authorization is revoked', async () => {
  const { client, events } = connect(false)
  try {
    expect(await client.request('initialize', {})).toEqual({ ok: true })
    client.notify('permission', {})
    await expect.poll(() => events).toEqual([{ method: 'approval', params: { outcome: { outcome: 'cancelled' } } }])
    await expect(client.request('never', {}, 20)).rejects.toThrow('timed out')
  } finally { await client.close() }
})
it.each(['exit', 'invalid'])('rejects pending requests on %s and closes its owned process', async method => {
  const { client } = connect()
  try { await expect(client.request(method, {})).rejects.toThrow() }
  finally { await client.close() }
})
