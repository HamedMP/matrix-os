import { createCoreIndex, indexSource, resolvesInCore } from "./native-core-symbols";

function indexOf(source: string, language: "kotlin" | "java" = "kotlin") {
  const index = createCoreIndex();
  indexSource(index, source, language);
  return index;
}

describe("native core symbol index", () => {
  it("resolves top-level types, functions, properties and type aliases", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      class ColorCompat private constructor()
      data object Marker
      fun interface Converter { fun convert(value: Any): Any }
      typealias ColorInt = Int
      fun <T : Any> List<T>.toKClass(): Int = 1
      val Converter.label: String get() = "x"
      const val DEFAULT_ALPHA = 1f
    `);

    for (const name of ["ColorCompat", "Marker", "Converter", "ColorInt", "toKClass", "label", "DEFAULT_ALPHA"]) {
      expect(resolvesInCore(index, `expo.modules.kotlin.types.${name}`)).toBe(true);
    }
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Missing")).toBe(false);
  });

  it("finds a declaration that follows a wildcard import", () => {
    const index = indexOf(`
      package expo.modules.core.utilities

      import java.util.*

      object EmulatorUtilities {
        fun isRunningOnEmulator() = false
      }
    `);

    expect(resolvesInCore(index, "expo.modules.core.utilities.EmulatorUtilities")).toBe(true);
  });

  it("does not treat a nested class as a top-level class of the package", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      class Palette {
        class ColorCompat
      }
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.ColorCompat")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Palette.ColorCompat")).toBe(true);
  });

  it("ignores declarations that only appear in comments", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      // class ColorCompat was considered
      /* object ColorCompat /* nested comment */ class ColorCompat */
      /** Use [ColorCompat]: class ColorCompat */
      class Real
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.ColorCompat")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Real")).toBe(true);
  });

  it("ignores declarations that only appear in string literals and keeps its place after them", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      val template = "class ColorCompat { \${names["key"] + "}"} {"
      val raw = """
        class ColorCompat {
      """
      val brace = '{'
      class AfterStrings
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.ColorCompat")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.AfterStrings")).toBe(true);
  });

  it("ignores declarations local to a function body", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      fun build() {
        class ColorCompat
        val local = object : Runnable { override fun run() {} }
      }
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.ColorCompat")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.local")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.build")).toBe(true);
  });

  it("does not let a member named like a package segment resolve the whole package", () => {
    const index = indexOf(`
      package expo.modules.kotlin

      class Registry {
        val types = mutableListOf<String>()
      }
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.ColorCompat")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types")).toBe(false);
  });

  it("does not count class references or anonymous objects as declarations", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      val kind = ColorCompat::class
      val listener = object : Runnable { override fun run() {} }
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.ColorCompat")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Runnable")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.kind")).toBe(true);
  });

  it("resolves members through the type that declares them", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      enum class Channel(val shift: Int) {
        RED(16), GREEN(8);

        fun mask() = 0xff shl shift
      }

      class Palette {
        companion object {
          fun create() = Palette()
        }
      }
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.Channel.RED")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Channel.mask")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Palette.Companion.create")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Palette.create")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Channel.BLUE")).toBe(false);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.Palette.Missing.create")).toBe(false);
  });

  it("resolves a wildcard import only for a package or type that exists", () => {
    const index = indexOf(`
      package expo.modules.kotlin.types

      class ColorCompat
    `);

    expect(resolvesInCore(index, "expo.modules.kotlin.types.*")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.types.ColorCompat.*")).toBe(true);
    expect(resolvesInCore(index, "expo.modules.kotlin.missing.*")).toBe(false);
  });

  it("applies the same rules to Java sources", () => {
    const index = indexOf(
      `
      package expo.modules.core;

      /* class Ghost */
      public class Promise {
        public static class Inner {}
        Class<?> kind = Hidden.class;
        String text = "class Quoted {";
        Object object = new Object();
      }
      enum Mode { ON, OFF }
      @interface Marker {}
    `,
      "java",
    );

    for (const name of ["Promise", "Promise.Inner", "Mode", "Mode.ON", "Marker"]) {
      expect(resolvesInCore(index, `expo.modules.core.${name}`)).toBe(true);
    }
    for (const name of ["Ghost", "Inner", "Hidden", "Quoted", "object"]) {
      expect(resolvesInCore(index, `expo.modules.core.${name}`)).toBe(false);
    }
  });
});
