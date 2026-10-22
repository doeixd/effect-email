import { assert, describe, it } from "@effect/vitest"
import * as Smtp from "../src/smtp/Protocol"

const bytes = (value: string): Uint8Array =>
  new TextEncoder().encode(value)

const text = (value: Uint8Array): string =>
  new TextDecoder().decode(value)

describe("SMTP line framing", () => {
  it("handles split and pipelined commands", () => {
    const first = Smtp.pushLineFrame(
      Smtp.emptyLineFrame,
      bytes("EHLO exa")
    )
    assert.deepStrictEqual(first.lines, [])

    const second = Smtp.pushLineFrame(
      first.frame,
      bytes("mple\r\nNOOP\r\n")
    )
    assert.deepStrictEqual(second.lines, ["EHLO example", "NOOP"])
    assert.strictEqual(second.overflow, false)
  })

  it("discards an overlong line and resynchronizes", () => {
    const result = Smtp.pushLineFrame(
      Smtp.emptyLineFrame,
      bytes("TOOLONG\r\nNOOP\r\n"),
      5
    )

    assert.isTrue(result.overflow)
    assert.deepStrictEqual(result.lines, ["NOOP"])
  })

  it("discards an overlong fragmented line", () => {
    const first = Smtp.pushLineFrame(
      Smtp.emptyLineFrame,
      bytes("TOOLONG"),
      5
    )
    const second = Smtp.pushLineFrame(
      first.frame,
      bytes("CONTINUES\r\nNOOP\r\n"),
      5
    )

    assert.isTrue(first.overflow)
    assert.deepStrictEqual(second.lines, ["NOOP"])
  })
})

describe("SMTP DATA decoding", () => {
  it("recognizes a terminator split across packets and unstuffs dots", () => {
    const first = Smtp.pushData(
      Smtp.emptyDataDecoder,
      bytes("Hello\r\n..dot\r\n\u002E")
    )
    assert.isFalse(first.complete)

    const second = Smtp.pushData(
      first.decoder,
      bytes("\r\nNOOP\r\n")
    )

    assert.isTrue(second.complete)
    assert.strictEqual(second.tooLarge, false)
    assert.strictEqual(text(second.content!), "Hello\r\n.dot\r\n")
    assert.strictEqual(text(second.remainder!), "NOOP\r\n")
  })

  it("reports an oversized message but consumes through the terminator", () => {
    const first = Smtp.pushData(
      Smtp.emptyDataDecoder,
      bytes("0123456789"),
      5
    )
    assert.isTrue(first.tooLarge)
    assert.isFalse(first.complete)

    const second = Smtp.pushData(
      first.decoder,
      bytes("\r\n.\r\nNOOP\r\n"),
      5
    )
    assert.isTrue(second.complete)
    assert.isTrue(second.tooLarge)
    assert.strictEqual(second.content, undefined)
    assert.strictEqual(text(second.remainder!), "NOOP\r\n")
  })
})

describe("SMTP session transitions", () => {
  const command = (
    state: Smtp.SmtpSessionState,
    line: string
  ): Smtp.SmtpTransition =>
    Smtp.transition(state, Smtp.parseCommand(line))

  it("drives a complete null-sender transaction", () => {
    const greeted = command(Smtp.initialSession, "EHLO client")
    assert.strictEqual(greeted.replies[0]?.code, 250)
    assert.strictEqual(greeted.state.helo, "client")

    const mail = command(greeted.state, "MAIL FROM:<> SIZE=10")
    assert.strictEqual(mail.replies[0]?.code, 250)
    assert.strictEqual(mail.state.mailFrom, null)

    const rcpt = command(mail.state, "RCPT TO:<user@example.com>")
    assert.strictEqual(rcpt.state.recipients.length, 1)

    const data = command(rcpt.state, "DATA")
    assert.isTrue(data.beginData)
    assert.strictEqual(data.state.phase, "data")

    const complete = Smtp.completeData(
      data.state,
      bytes("Subject: hello\r\n\r\nBody\r\n")
    )
    assert.strictEqual(complete.replies[0]?.code, 250)
    assert.strictEqual(complete.submission?.mailFrom, null)
    assert.deepStrictEqual(complete.submission?.rcptTo, [
      "user@example.com"
    ])
    assert.strictEqual(complete.state.phase, "command")
    assert.deepStrictEqual(complete.state.recipients, [])
  })

  it("rejects bad sequencing and resets transactions", () => {
    const rcpt = command(
      Smtp.initialSession,
      "RCPT TO:<user@example.com>"
    )
    assert.strictEqual(rcpt.replies[0]?.code, 503)

    const greeted = command(Smtp.initialSession, "HELO client")
    const mail = command(greeted.state, "MAIL FROM:<a@example.com>")
    const recipient = command(mail.state, "RCPT TO:<b@example.com>")

    const reset = command(recipient.state, "RSET")
    assert.strictEqual(reset.state.mailFrom, undefined)
    assert.deepStrictEqual(reset.state.recipients, [])
    assert.strictEqual(reset.state.helo, "client")
  })

  it("closes on QUIT and reports unknown commands", () => {
    const unknown = command(Smtp.initialSession, "VRFY user@example.com")
    assert.strictEqual(unknown.replies[0]?.code, 500)

    const quit = command(Smtp.initialSession, "QUIT")
    assert.isTrue(quit.close)
    assert.strictEqual(quit.state.phase, "closed")
  })

  it("encodes multiline replies with the final line space", () => {
    const encoded = text(
      Smtp.encodeReply({
        code: 250,
        lines: ["one", "two"]
      })
    )

    assert.strictEqual(encoded, "250-one\r\n250 two\r\n")
  })
})
