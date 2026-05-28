/**
 * Post a message to a Slack `response_url` (interactivity + slash-command follow-ups).
 * Defaults to an ephemeral reply visible only to the invoking user.
 */
export async function respondEphemeral(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ response_type: "ephemeral", text }),
  });
}
