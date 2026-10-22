const root = await import("../dist/index.js")
const required = [
  "Message",
  "Email",
  "EmailTransport",
  "EmailError",
  "DeliveryStore",
  "Submissions",
  "Submission",
  "SubmissionAdmission",
  "Template",
  "Spool",
  "Suppression",
  "Gateway",
  "Catcher",
  "Ids"
]

for (const name of required) {
  if (!(name in root)) {
    throw new Error(`missing root export: ${name}`)
  }
}

await import("../dist/TransportRegistry.js")
await import("../dist/providers/Resend.js")
await import("../dist/server/Gateway.js")
await import("../dist/smtp/Protocol.js")
await import("../dist/workflow/Submissions.js")

console.log("dist smoke test passed")
