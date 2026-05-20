import { describe, expect, it } from "vitest";
import {
  buildUmbrellaNote,
  weatherCodeToJapanese,
} from "../src/weather/openMeteo";

describe("weather helpers", () => {
  it("maps Open-Meteo weather codes to Japanese labels", () => {
    expect(weatherCodeToJapanese(0)).toBe("快晴");
    expect(weatherCodeToJapanese(3)).toBe("くもり");
    expect(weatherCodeToJapanese(61)).toBe("雨");
    expect(weatherCodeToJapanese(95)).toBe("雷雨");
    expect(weatherCodeToJapanese(999)).toBe("不明");
  });

  it("builds umbrella guidance from rain probability, precipitation, and weather code", () => {
    expect(buildUmbrellaNote(20, 0, 1)).toBe("傘は不要そうです。");
    expect(buildUmbrellaNote(35, 0, 2)).toBe("折りたたみ傘があると安心です。");
    expect(buildUmbrellaNote(55, 0, 2)).toBe("傘があると安心です。");
    expect(buildUmbrellaNote(10, 1.2, 2)).toBe("傘があると安心です。");
    expect(buildUmbrellaNote(10, 0, 61)).toBe("傘があると安心です。");
  });
});
