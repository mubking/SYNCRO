import logger from '../config/logger';

export async function sendSlackAlert(webhookUrl: string, text: string): Promise<void> {
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      logger.warn('Slack webhook returned non-OK status', { status: res.status });
    }
  } catch (err) {
    logger.error('Failed to send Slack alert', { err });
  }
}
