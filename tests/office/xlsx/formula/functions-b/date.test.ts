import { describe, expect, it } from "vitest";
import type { FormulaError, FormulaScalar } from "../../../../../packages/office/src/api/formula.js";
import { err, setup } from "./setup.js";

describe("date and time functions", () => {
  const { value, functions } = setup();

  it.each<[string, FormulaScalar]>([
    ["DATE(2024,1,15)", 45306],
    ["DATE(1900,1,1)", 1],
    ["DATE(1900,2,28)", 59],
    ["DATE(1900,2,29)", 60],
    ["DATE(1900,3,1)", 61],
    ["DATE(24,1,1)", 8767],
    ["DATE(2024,14,1)", 45689],
    ["DATE(2024,1,0)", 45291],
    ["DATE(2024,-1,1)", 45231],
    ["DATE(2024.9,1.9,15.9)", 45306],
    ["TIME(12,0,0)", 0.5],
    ["TIME(0,90,0)", 0.0625],
    ["TIME(24,0,0)", 0],
    ["TIME(1,-30,0)", 1 / 48],
    ["NOW()", 46349 + 14.5 / 24],
    ["TODAY()", 46349],
    ["YEAR(45306)", 2024],
    ["MONTH(45306)", 1],
    ["DAY(45306)", 15],
    ['YEAR("2024-03-05")', 2024],
    ['MONTH("Mar 5, 2024")', 3],
    ["DAY(60)", 29],
    ["MONTH(60)", 2],
    ["DAY(61)", 1],
    ["DAY(0)", 0],
    ["HOUR(0.75)", 18],
    ["MINUTE(TIME(12,15,0))", 15],
    ["SECOND(TIME(1,2,3))", 3],
    ["HOUR(45306.999999)", 0],
    ['HOUR("18:30")', 18],
    ["WEEKDAY(45306)", 2],
    ["WEEKDAY(45306,2)", 1],
    ["WEEKDAY(45306,3)", 0],
    ["WEEKDAY(45306,11)", 1],
    ["WEEKDAY(45306,16)", 3],
    ["WEEKDAY(45306,17)", 2],
    ["WEEKDAY(1)", 1],
    ["WEEKNUM(DATE(2024,1,1))", 1],
    ["WEEKNUM(DATE(2024,1,7))", 2],
    ["WEEKNUM(DATE(2024,1,7),2)", 1],
    ["WEEKNUM(DATE(2024,12,31))", 53],
    ["WEEKNUM(DATE(2024,12,31),21)", 1],
    ["ISOWEEKNUM(DATE(2021,1,1))", 53],
    ["ISOWEEKNUM(DATE(2024,12,30))", 1],
    ["ISOWEEKNUM(DATE(2024,6,15))", 24],
    ["EDATE(DATE(2024,1,31),1)", 45351],
    ["EDATE(DATE(2024,3,31),-1)", 45351],
    ["EDATE(45306.7,1)", 45337],
    ["EDATE(45306,0)", 45306],
    ["EOMONTH(DATE(2024,1,15),1)", 45351],
    ["EOMONTH(DATE(2024,1,15),-1)", 45291],
    ["EOMONTH(DATE(2024,1,15),0)", 45322],
    ['DATEDIF(DATE(2020,2,29),DATE(2024,2,28),"Y")', 3],
    ['DATEDIF(DATE(2020,2,29),DATE(2024,2,28),"m")', 47],
    ['DATEDIF(DATE(2020,2,29),DATE(2024,2,28),"D")', 1460],
    ['DATEDIF(DATE(2020,2,29),DATE(2024,2,28),"YM")', 11],
    ['DATEDIF(DATE(2024,1,10),DATE(2024,3,5),"MD")', 24],
    ['DATEDIF(DATE(2024,1,10),DATE(2024,3,15),"MD")', 5],
    ['DATEDIF(DATE(2023,6,15),DATE(2024,3,1),"YD")', 260],
    ['DATEDIF(DATE(2024,1,1),DATE(2024,1,1),"D")', 0],
    ["DAYS(DATE(2024,3,1),DATE(2024,2,1))", 29],
    ['DAYS("2024-03-01","2024-02-01")', 29],
    ["DAYS(DATE(2024,2,1),DATE(2024,3,1))", -29],
    ["NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31))", 23],
    ["NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31),H1:H2)", 21],
    ["NETWORKDAYS(DATE(2024,1,31),DATE(2024,1,1))", -23],
    ["NETWORKDAYS(DATE(2024,1,6),DATE(2024,1,7))", 0],
    ["NETWORKDAYS(DATE(2024,1,1),DATE(2024,1,31),{45293,45293,45297})", 22],
    ["WORKDAY(DATE(2024,1,5),1)", 45299],
    ["WORKDAY(DATE(2024,1,1),10)", 45306],
    ["WORKDAY(DATE(2024,1,1),10,H1:H2)", 45308],
    ["WORKDAY(DATE(2024,1,15),-5)", 45299],
    ["WORKDAY(DATE(2024,1,6),1)", 45299],
    ["WORKDAY(DATE(2024,1,6),-1)", 45296],
    ["WORKDAY(DATE(2024,1,6),0)", 45297],
    ['DATEVALUE("2024-01-15")', 45306],
    ['DATEVALUE("15-Jan-2024")', 45306],
    ['DATEVALUE("15 january 2024")', 45306],
    ['DATEVALUE("Jan 15, 2024")', 45306],
    ['DATEVALUE("January 15 2024 3:00 PM")', 45306],
    ['DATEVALUE("1/15/24")', 45306],
    ['DATEVALUE("2024/1/15")', 45306],
    ['DATEVALUE("15-Jan")', 46037],
    ['DATEVALUE("2/29/1900")', 60],
    ['VALUE("Jan 15, 2024 6:00 PM")', 45306.75],
    ["YEARFRAC(DATE(2012,1,1),DATE(2012,7,30))", 209 / 360],
    ["YEARFRAC(DATE(2012,7,30),DATE(2012,1,1))", 209 / 360],
    ["YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),1)", 211 / 366],
    ["YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),3)", 211 / 365],
    ["YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),2)", 211 / 360],
    ["YEARFRAC(DATE(2023,1,31),DATE(2023,2,28),0)", 28 / 360],
    ["YEARFRAC(DATE(2023,1,31),DATE(2023,3,31),0)", 60 / 360],
    ["YEARFRAC(DATE(2023,2,28),DATE(2024,2,29),0)", 1],
    ["YEARFRAC(DATE(2023,1,31),DATE(2023,3,31),4)", 60 / 360],
    ["YEARFRAC(DATE(2023,3,1),DATE(2024,3,1),1)", 366 / 366],
    ["YEARFRAC(DATE(2010,1,1),DATE(2012,7,1),1)", 912 / (1096 / 3)],
  ])("%s is %j", (text, expected) => {
    const result = value(text);
    if (typeof expected === "number" && !Number.isInteger(expected)) expect(result).toBeCloseTo(expected, 9);
    else expect(result).toBe(expected);
  });

  it.each<[string, FormulaError["code"]]>([
    ["DATE(-1,1,1)", "#NUM!"],
    ["DATE(10000,1,1)", "#NUM!"],
    ["DATE(1900,1,-1)", "#NUM!"],
    ['DATE("x",1,1)', "#VALUE!"],
    ["TIME(0,-1,0)", "#NUM!"],
    ["TIME(40000,0,0)", "#NUM!"],
    ["YEAR(-1)", "#NUM!"],
    ["YEAR(3000000)", "#NUM!"],
    ['YEAR("not a date")', "#VALUE!"],
    ["MONTH(1/0)", "#DIV/0!"],
    ["WEEKDAY(45306,4)", "#NUM!"],
    ["WEEKNUM(45306,3)", "#NUM!"],
    ["EDATE(-1,1)", "#NUM!"],
    ["EDATE(DATE(1900,1,1),-1)", "#NUM!"],
    ["EOMONTH(DATE(1900,1,1),-2)", "#NUM!"],
    ['DATEDIF(DATE(2024,2,1),DATE(2024,1,1),"D")', "#NUM!"],
    ['DATEDIF(DATE(2024,1,1),DATE(2024,2,1),"W")', "#NUM!"],
    ["NETWORKDAYS(1,10,{\"x\"})", "#VALUE!"],
    ["NETWORKDAYS(1,10,{1,#N/A})", "#N/A"],
    ["WORKDAY(DATE(1900,1,2),-5)", "#NUM!"],
    ['DATEVALUE("2/30/2024")', "#VALUE!"],
    ['DATEVALUE("hello")', "#VALUE!"],
    ["DATEVALUE(45306)", "#VALUE!"],
    ['DATEVALUE("13/1/2024")', "#VALUE!"],
    ["YEARFRAC(1,2,5)", "#NUM!"],
    ["YEARFRAC(1,2,-1)", "#NUM!"],
  ])("%s is %s", (text, code) => {
    expect(value(text)).toEqual(err(code));
  });

  it("takes the current instant only from the evaluation context", () => {
    const without = setup({ now: null });
    expect(without.value("NOW()")).toEqual(err("#N/A"));
    expect(without.value("TODAY()")).toEqual(err("#N/A"));
    expect(without.value('DATEVALUE("15-Jan")')).toEqual(err("#VALUE!"));
    expect(setup({ now: "2024-01-15" }).value("NOW()")).toBe(45306);
    expect(setup({ now: "2024-01-15T06:00:00+02:00" }).value("NOW()")).toBe(45306.25);
    expect(setup({ now: "yesterday" }).value("TODAY()")).toEqual(err("#N/A"));
    expect(functions.describe("NOW")?.volatile).toBe(true);
    expect(functions.describe("TODAY")?.volatile).toBe(true);
    expect(functions.describe("DATE")?.volatile).toBe(false);
  });

  it("uses the 1904 date system when the workbook does", () => {
    const mac = setup({ date1904: true });
    expect(mac.value("DATE(1904,1,1)")).toBe(0);
    expect(mac.value("DATE(2024,1,15)")).toBe(45306 - 1462);
    expect(mac.value("YEAR(0)")).toBe(1904);
    expect(mac.value("WEEKDAY(0)")).toBe(6);
    expect(mac.value("DATE(1903,12,31)")).toEqual(err("#NUM!"));
    expect(mac.value('DATEVALUE("2024-01-15")')).toBe(45306 - 1462);
  });

  it("agrees with a day-by-day count for WORKDAY and NETWORKDAYS", () => {
    const holidays = [45293, 45307, 45350, 45351, 45352, 45400];
    const isWorkday = (d: number) => (d + 6) % 7 !== 0 && (d + 6) % 7 !== 6 && !holidays.includes(d);
    const workday = (start: number, n: number) => {
      let d = start;
      let left = Math.abs(n);
      while (left > 0) {
        d += n > 0 ? 1 : -1;
        if (isWorkday(d)) left -= 1;
      }
      return d;
    };
    const list = `{${holidays.join(",")}}`;
    for (const start of [45290, 45292, 45296, 45297, 45298, 45349, 45401]) {
      for (const n of [1, 2, 4, 5, 6, 9, 10, 11, 37, 120, -1, -3, -5, -6, -44]) {
        expect(value(`WORKDAY(${start},${n},${list})`), `WORKDAY(${start},${n})`).toBe(workday(start, n));
      }
      for (const end of [start, start + 1, start + 6, start + 7, start + 100, start - 40]) {
        let count = 0;
        for (let d = Math.min(start, end); d <= Math.max(start, end); d += 1) if (isWorkday(d)) count += 1;
        expect(value(`NETWORKDAYS(${start},${end},${list})`)).toBe(start <= end ? count : -count);
      }
    }
  });

  it("handles long spans without walking every day", () => {
    // Serial 1 is a Sunday: the 2 000 000th weekday after it is the Friday 400 000 weeks later.
    expect(value("WORKDAY(1,2000000)")).toBe(1 + 400_000 * 7 - 2);
    expect(value("NETWORKDAYS(1,2958465)")).toBeGreaterThan(2_000_000);
  });
});
