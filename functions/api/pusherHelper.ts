import crypto from "node:crypto";

interface Env {
  PUSHER_APP_ID: string;
  PUSHER_KEY: string;
  PUSHER_SECRET: string;
  PUSHER_CLUSTER: string;
}

export async function triggerPusherEvent(
  env: Env,
  channel: string,
  event: string,
  data: unknown
): Promise<void> {
  const appId = env.PUSHER_APP_ID;
  const key = env.PUSHER_KEY;
  const secret = env.PUSHER_SECRET;
  const cluster = env.PUSHER_CLUSTER;

  const requestBody = JSON.stringify({
    name: event,
    channels: [channel],
    data: JSON.stringify(data),
  });
  const bodyMd5 = crypto.createHash("md5").update(requestBody).digest("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const stringToSign = [
    "POST",
    `/apps/${appId}/events`,
    [
      `auth_key=${key}`,
      `auth_timestamp=${timestamp}`,
      `auth_version=1.0`,
      `body_md5=${bodyMd5}`,
    ].join("&"),
  ].join("\n");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(stringToSign)
    .digest("hex");

  const url = `https://api-${cluster}.pusher.com/apps/${appId}/events?auth_key=${key}&auth_timestamp=${timestamp}&auth_version=1.0&body_md5=${bodyMd5}&auth_signature=${signature}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Pusher API error: ${response.status} ${text}`);
  }
}
