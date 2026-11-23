import {
  APP_FILES_BRIDGE_PATH,
  APP_FILE_ERROR_MESSAGES,
  APP_FILE_ERROR_STATUS,
  APP_FILE_LIST_MAX_ENTRIES,
  APP_FILE_MAX_BYTES,
  APP_FILE_PATH_MAX_CHARS,
  APP_FILE_TIMEOUT_MS,
} from "@matrix-os/contracts/app-files";
import {
  OPEN_REQUEST_KV_KEY,
  OPEN_REQUEST_MAX_FUTURE_SKEW_MS,
  OPEN_REQUEST_MAX_LISTENERS,
  OPEN_REQUEST_TTL_MS,
} from "@matrix-os/contracts/office-open-with";

/** The frame waits a little longer than the parent so the parent's own timeout reply arrives first. */
const FRAME_TIMEOUT_MS = APP_FILE_TIMEOUT_MS + 5_000;
const SEEN_OPEN_REQUESTS = 32;

/**
 * Source of the `MatrixOS.files` expression in the injected bridge script.
 * It mirrors `createAppFilesClient` and `createOpenRequestInbox` from the
 * contracts without Zod, because the frame has no module loader.
 *
 * It runs inside the bridge closure and uses these names from it:
 * `app`, `parentFetch`, `dataChangeCallbacks` and `window.MatrixOS.readData`
 * / `writeData`. The trusted parent re-validates every input and reply.
 */
export function buildFilesBridgeSource(): string {
  return `(function() {
      var filesPath = ${JSON.stringify(APP_FILES_BRIDGE_PATH)};
      var fileMessages = ${JSON.stringify(APP_FILE_ERROR_MESSAGES)};
      var fileStatus = ${JSON.stringify(APP_FILE_ERROR_STATUS)};
      var maxFileBytes = ${APP_FILE_MAX_BYTES};
      var openRequestKey = ${JSON.stringify(OPEN_REQUEST_KV_KEY)};
      var seenOpenRequests = [];
      var openRequestListeners = [];
      var openRequestChange = null;

      function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

      function fileError(code) {
        var known = hasOwn(fileMessages, code) ? code : "unavailable";
        var error = new Error(fileMessages[known]);
        error.name = "BridgeFileError";
        error.code = known;
        return error;
      }

      function codeForStatus(status) {
        for (var code in fileStatus) if (hasOwn(fileStatus, code) && fileStatus[code] === status) return code;
        return "unavailable";
      }

      function isFilePath(value) {
        if (typeof value !== "string" || value.length < 1 || value.length > ${APP_FILE_PATH_MAX_CHARS}) return false;
        if (value.indexOf("\\u0000") >= 0 || value.indexOf("\\\\") >= 0) return false;
        var segments = value.split("/");
        for (var i = 0; i < segments.length; i++) {
          if (segments[i] === "" || segments[i] === "." || segments[i] === "..") return false;
        }
        return true;
      }

      function isVersion(value) {
        return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
      }

      function encodeBase64(bytes) {
        var binary = "";
        for (var offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      }

      function decodeBase64(text) {
        var binary = atob(text);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }

      function request(input) {
        return parentFetch(filesPath, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input)
        }, ${FRAME_TIMEOUT_MS}).then(function(response) { return response.json(); }, function(error) {
          throw fileError(error && typeof error.status === "number" ? codeForStatus(error.status) : "unavailable");
        }).then(function(reply) {
          if (!reply || typeof reply !== "object") throw fileError("unavailable");
          if (reply.error && typeof reply.error === "object") throw fileError(reply.error.code);
          return reply;
        });
      }

      function invalid() { return Promise.reject(fileError("invalid_request")); }

      // Open requests: read once, deliver each nonce once, then clear the key.
      function parseOpenRequest(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        var keys = Object.keys(value);
        if (keys.length !== 3 || !hasOwn(value, "path") || !hasOwn(value, "requestedAt") || !hasOwn(value, "nonce")) return null;
        if (!isFilePath(value.path) || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value.nonce)) return null;
        if (typeof value.requestedAt !== "string" || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$/.test(value.requestedAt)) return null;
        var age = Date.now() - Date.parse(value.requestedAt);
        if (!(age <= ${OPEN_REQUEST_TTL_MS} && age >= -${OPEN_REQUEST_MAX_FUTURE_SKEW_MS})) return null;
        return { path: value.path, requestedAt: value.requestedAt, nonce: value.nonce };
      }

      function readOpenRequest() {
        var stored;
        try { stored = window.MatrixOS.readData(openRequestKey); } catch (err) { stored = Promise.reject(err); }
        return Promise.resolve(stored).then(function(value) {
          if (value === null || value === undefined) return null;
          var parsed = parseOpenRequest(value);
          var fresh = parsed !== null && seenOpenRequests.indexOf(parsed.nonce) < 0;
          if (fresh) {
            seenOpenRequests.push(parsed.nonce);
            if (seenOpenRequests.length > ${SEEN_OPEN_REQUESTS}) seenOpenRequests.shift();
          }
          // A failed clear is safe: the nonce is remembered and the request expires.
          Promise.resolve().then(function() { return window.MatrixOS.writeData(openRequestKey, null); }).catch(function(err) {
            console.warn("[MatrixOS bridge] open request clear unavailable", err instanceof Error ? err.name : "UnknownError");
          });
          return fresh ? parsed : null;
        }, function(err) {
          console.warn("[MatrixOS bridge] open request read unavailable", err instanceof Error ? err.name : "UnknownError");
          return null;
        });
      }

      function onOpenRequestChange(key, changedApp) {
        if (key !== openRequestKey || changedApp !== app) return;
        readOpenRequest().then(function(next) {
          if (!next) return;
          var current = openRequestListeners.slice();
          for (var i = 0; i < current.length; i++) {
            try { current[i](next); } catch (err) {
              console.warn("[MatrixOS bridge] open request listener failed", err instanceof Error ? err.name : "UnknownError");
            }
          }
        });
      }

      return Object.freeze({
        list: function(dir, options) {
          var input = { kind: "files.list", dir: dir };
          if (options && options.limit !== undefined) input.limit = options.limit;
          if (dir !== "" && !isFilePath(dir)) return invalid();
          if (input.limit !== undefined && (typeof input.limit !== "number" || input.limit % 1 !== 0 || input.limit < 1 || input.limit > ${APP_FILE_LIST_MAX_ENTRIES})) return invalid();
          return request(input);
        },
        stat: function(path) {
          return isFilePath(path) ? request({ kind: "files.stat", path: path }) : invalid();
        },
        read: function(path) {
          if (!isFilePath(path)) return invalid();
          return request({ kind: "files.read", path: path }).then(function(reply) {
            if (typeof reply.contentBase64 !== "string") throw fileError("unavailable");
            var bytes;
            try { bytes = decodeBase64(reply.contentBase64); } catch (err) { throw fileError("unavailable"); }
            return { path: reply.path, bytes: bytes, size: reply.size, version: reply.version, mimeType: reply.mimeType };
          });
        },
        write: function(path, bytes, options) {
          if (!isFilePath(path) || !(bytes instanceof Uint8Array) || !options || typeof options !== "object") return invalid();
          if (options.ifVersion !== null && !isVersion(options.ifVersion)) return invalid();
          if (options.createParents !== undefined && typeof options.createParents !== "boolean") return invalid();
          if (bytes.byteLength > maxFileBytes) return Promise.reject(fileError("too_large"));
          var input = { kind: "files.write", path: path, contentBase64: encodeBase64(bytes), ifVersion: options.ifVersion };
          if (options.createParents !== undefined) input.createParents = options.createParents;
          return request(input);
        },
        mkdir: function(path) {
          return isFilePath(path) ? request({ kind: "files.mkdir", path: path }) : invalid();
        },
        openRequest: readOpenRequest,
        onOpenRequest: function(callback) {
          if (typeof callback !== "function" || openRequestListeners.length >= ${OPEN_REQUEST_MAX_LISTENERS}) {
            throw new Error("Open requests are unavailable");
          }
          openRequestListeners.push(callback);
          if (!openRequestChange) {
            openRequestChange = onOpenRequestChange;
            dataChangeCallbacks.push(openRequestChange);
          }
          return function() {
            var idx = openRequestListeners.indexOf(callback);
            if (idx < 0) return;
            openRequestListeners.splice(idx, 1);
            if (openRequestListeners.length === 0 && openRequestChange) {
              var at = dataChangeCallbacks.indexOf(openRequestChange);
              if (at >= 0) dataChangeCallbacks.splice(at, 1);
              openRequestChange = null;
            }
          };
        }
      });
    })()`;
}
