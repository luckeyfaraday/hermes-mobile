import assert from 'node:assert/strict'
import test from 'node:test'
import { readStream } from './app.js'

globalThis.requestAnimationFrame = callback => {
  callback()
  return 1
}
globalThis.cancelAnimationFrame = () => {}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function streamFromEvents(events) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event))
      }
      controller.close()
    }
  })
}

test('assistant.delta appends repeated delta chunks', async () => {
  const assistant = { role: 'assistant', parts: [] }

  await readStream(
    streamFromEvents([
      sse('assistant.delta', { delta: 'ha' }),
      sse('assistant.delta', { delta: 'ha' }),
      sse('assistant.delta', { delta: '!' })
    ]),
    assistant
  )

  assert.deepEqual(assistant.parts, [{ type: 'text', text: 'haha!' }])
})

test('assistant.completed reconciles existing text part after tool events', async () => {
  const assistant = { role: 'assistant', parts: [] }

  await readStream(
    streamFromEvents([
      sse('assistant.delta', { delta: 'hello' }),
      sse('tool.started', { tool_name: 'search', args: { q: 'hello' } }),
      sse('tool.completed', { tool_name: 'search', preview: 'done' }),
      sse('assistant.completed', { content: 'hello world' })
    ]),
    assistant
  )

  assert.equal(assistant.parts.filter(part => part.type === 'text').length, 1)
  assert.equal(assistant.parts.find(part => part.type === 'text')?.text, 'hello world')
  assert.equal(assistant.parts.find(part => part.type === 'tool')?.status, 'done')
})

test('reasoning progress appends repeated delta chunks', async () => {
  const assistant = { role: 'assistant', parts: [] }

  await readStream(
    streamFromEvents([
      sse('tool.progress', { tool_name: '_thinking', delta: 'hm' }),
      sse('tool.progress', { tool_name: '_thinking', delta: 'hm' })
    ]),
    assistant
  )

  assert.deepEqual(assistant.parts, [{ type: 'reasoning', text: 'hmhm' }])
})
