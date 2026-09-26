// Cloudflare Email Worker: passes every email sent to <anything>@your-domain to Homework Hub.
// Setup: see README → "Turn on email forwarding". Needs two variables on the Worker:
//   HUB_URL         e.g. https://your-hub.up.railway.app
//   INBOUND_SECRET  the same value as INBOUND_SECRET on the server
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).arrayBuffer();
    const res = await fetch(`${env.HUB_URL.replace(/\/+$/, "")}/api/inbound/email`, {
      method: "POST",
      headers: { "Content-Type": "message/rfc822", "X-Inbound-Secret": env.INBOUND_SECRET, "X-Envelope-To": message.to },
      body: raw,
    });
    // Never bounce: a bounce can make Gmail turn forwarding off. Just log problems.
    if (!res.ok) console.log(`Homework Hub answered ${res.status} for ${message.to}`);
  },
};
