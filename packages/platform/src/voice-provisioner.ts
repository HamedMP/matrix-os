export interface VoiceProvisionerConfig {
  accountSid: string;
  authToken: string;
}

export interface ProvisionResult {
  phoneNumber: string;
  sid: string;
}

export class VoiceProvisioner {
  private accountSid: string;
  private authToken: string;

  constructor(config: VoiceProvisionerConfig) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
  }

  async provisionNumber(handle: string): Promise<ProvisionResult | null> {
    if (!/^[a-z0-9-]{1,63}$/.test(handle)) {
      throw new Error(`Invalid handle: ${handle}`);
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/IncomingPhoneNumbers.json`;
    const webhookUrl = `https://${handle}.matrix-os.com/voice/webhook/twilio`;

    const body = new URLSearchParams({
      VoiceUrl: webhookUrl,
    });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        console.warn(
          `[voice-provisioner] Failed to provision number for ${handle}: HTTP ${response.status}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        sid: string;
        phone_number: string;
      };
      return {
        phoneNumber: data.phone_number,
        sid: data.sid,
      };
    } catch (err) {
      console.warn(
        `[voice-provisioner] Failed to provision number for ${handle}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  async releaseNumber(numberSid: string): Promise<void> {
    if (!/^PN[0-9a-f]{32}$/i.test(numberSid)) {
      throw new Error(`Invalid number SID format: ${numberSid}`);
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/IncomingPhoneNumbers/${numberSid}.json`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Twilio release failed (HTTP ${response.status})`,
      );
    }
  }
}
