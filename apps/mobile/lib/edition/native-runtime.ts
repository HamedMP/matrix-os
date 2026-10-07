import { AppState, Share } from "react-native";
import { MailActionRequestSchema } from "@matrix-os/contracts";
import {
  buildGatewayRequestUrl,
  createRequestTimeout,
} from "@/lib/requests/http";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import {
  createNativeEditionDownloads,
  type EditionComputer,
  type EditionStorage,
} from "./native-downloads";
import type { EditionRuntime } from "../../../../home/app-templates/connected-starter/src/edition/runtime";
export function createNativeEditionRuntime(options: {
  ownerId: string;
  computer: EditionComputer;
  getToken(): Promise<string | null>;
  isCurrent(): boolean;
  storage: EditionStorage;
  fetcher?: typeof fetch;
}): EditionRuntime & { retry(): void } {
  let connected = true;
  let invalidate = () => {};
  const downloads = createNativeEditionDownloads(options);
  const fetcher = options.fetcher ?? fetch;
  const check = () => {
    if (!options.isCurrent()) throw new Error("Reading session changed");
  };
  return {
    preview: false,
    online: () => connected,
    retry: () => {
      connected = true;
    },
    downloads,
    async bridge(action, payload = {}) {
      check();
      const request = MailActionRequestSchema.parse({
        appId: "edition",
        action,
        payload,
      });
      let token: string | null;
      try {
        token = await options.getToken();
      } catch {
        connected = false;
        throw new Error("Edition unavailable");
      }
      check();
      if (!token) {
        connected = false;
        throw new Error("Edition unavailable");
      }
      const timeout = createRequestTimeout(10000);
      try {
        const response = await fetcher(
          buildGatewayRequestUrl(
            `${HOSTED_GATEWAY_URL}${options.computer.gatewayPath}`,
            "/api/mail/action",
          ),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
            signal: timeout.signal,
          },
        );
        check();
        if (!response.ok) {
          if (
            action === "sources" &&
            (response.status === 401 || response.status === 403)
          ) {
            await downloads.clear();
            invalidate();
          }
          throw new Error("Edition unavailable");
        }
        const content = await response.text();
        check();
        if (content.length > 4 * 1024 * 1024)
          throw new Error("Edition unavailable");
        connected = true;
        return JSON.parse(content);
      } catch (error) {
        if (error instanceof TypeError || timeout.signal.aborted)
          connected = false;
        throw new Error("Edition unavailable");
      } finally {
        timeout.cancel();
      }
    },
    subscribe(reload, _offline, reset) {
      invalidate = reset;
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active" && options.isCurrent()) {
          connected = true;
          reload();
        }
      });
      return () => {
        invalidate = () => {};
        subscription.remove();
      };
    },
    async exportContent(content) {
      check();
      await Share.share({ title: "Edition export", message: content });
      check();
    },
  };
}
