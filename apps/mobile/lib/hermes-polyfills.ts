type SharedArrayBufferGlobal = {
  SharedArrayBuffer?: ArrayBufferConstructor;
};

const scope = globalThis as unknown as SharedArrayBufferGlobal;

if (typeof scope.SharedArrayBuffer === "undefined") {
  scope.SharedArrayBuffer = ArrayBuffer;
}

defineArrayBufferGetter("resizable", () => false);
defineArrayBufferGetter("growable", () => false);
defineArrayBufferGetter("maxByteLength", function getMaxByteLength(this: ArrayBuffer) {
  return this.byteLength;
});

if (typeof String.prototype.toWellFormed !== "function") {
  Object.defineProperty(String.prototype, "toWellFormed", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function toWellFormed(this: string) {
      return toWellFormedString(String(this));
    },
  });
}

if (typeof String.prototype.isWellFormed !== "function") {
  Object.defineProperty(String.prototype, "isWellFormed", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function isWellFormed(this: string) {
      return toWellFormedString(String(this)) === String(this);
    },
  });
}

function defineArrayBufferGetter(
  key: string,
  get: (this: ArrayBuffer) => boolean | number,
): void {
  if (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, key)) return;
  Object.defineProperty(ArrayBuffer.prototype, key, {
    configurable: true,
    enumerable: false,
    get,
  });
}

function toWellFormedString(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\ufffd";
      }
      continue;
    }
    result += code >= 0xdc00 && code <= 0xdfff ? "\ufffd" : value[index];
  }
  return result;
}
