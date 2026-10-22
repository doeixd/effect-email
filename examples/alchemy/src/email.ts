import * as Cloudflare from "alchemy/Cloudflare"

// Replace these with a verified sender and destination on your account.
export const SENDER = "bot@example.com"
export const DESTINATION = "you@example.com"

export const EmailBinding = Cloudflare.Email.SendEmail("EMAIL", {
  allowedSenderAddresses: [SENDER],
  destinationAddress: DESTINATION
})
