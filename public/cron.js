/* Cron for the heartbeat form: compile a day/time picker down to an
 * expression, read one back into the picker, and describe one in English.
 *
 * Deliberately a plain script rather than a module, because index.html loads
 * app.js as a classic script and a deferred module would run after it. It
 * hangs everything off one global and takes `root` as an argument so the same
 * file can be eval'd into a sandbox by cron.test.ts -- the browser and the
 * tests read the same bytes, which is the only reason this file is separate
 * from app.js at all (app.js has no test harness).
 *
 * The rule this file exists to keep: a cron expression is a CROSS PRODUCT of
 * minutes and hours, not a list of times. Ask for 08:00 and 20:30 and you get
 * four firings, not two. describeCron reports what will actually happen so
 * the form can show it rather than quietly lying. */
(function (root) {
  "use strict";

  // Day-of-week runs to 7: 0 and 7 both mean Sunday, matching the runner's
  // parse_cron_field, which folds 7 back to 0.
  var BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTH_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** One field -> a sorted array of the values it matches, or null if the
   * field is not something the runner would accept. */
  function parseField(field, index) {
    var bounds = BOUNDS[index];
    var low = bounds[0], high = bounds[1];
    var matched = {};
    var parts = String(field).split(",");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var slash = part.indexOf("/");
      var spec = slash === -1 ? part : part.slice(0, slash);
      var stepText = slash === -1 ? "" : part.slice(slash + 1);
      if (slash !== -1 && !/^\d+$/.test(stepText)) return null;
      var step = stepText ? Number(stepText) : 1;
      if (step < 1) return null;
      var start, end;
      if (spec === "*") {
        start = low;
        end = high;
      } else if (spec.indexOf("-") !== -1) {
        var dash = spec.indexOf("-");
        var startText = spec.slice(0, dash);
        var endText = spec.slice(dash + 1);
        if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)) return null;
        start = Number(startText);
        end = Number(endText);
      } else {
        // A bare value has no range for a step to walk through.
        if (!/^\d+$/.test(spec) || stepText) return null;
        start = end = Number(spec);
      }
      if (start < low || end > high || start > end) return null;
      for (var v = start; v <= end; v += step) matched[v] = true;
    }
    var values = Object.keys(matched).map(Number);
    if (index === 4 && values.indexOf(7) !== -1) {
      values = values.filter(function (v) { return v !== 7; });
      if (values.indexOf(0) === -1) values.push(0);
    }
    return values.sort(function (a, b) { return a - b; });
  }

  /** A 5-field expression -> five sorted value arrays, or null. */
  function parseCron(expr) {
    var trimmed = String(expr == null ? "" : expr).trim();
    if (!trimmed) return null;
    var fields = trimmed.split(/\s+/);
    if (fields.length !== 5) return null;
    var parsed = [];
    for (var i = 0; i < 5; i++) {
      var values = parseField(fields[i], i);
      if (values === null) return null;
      parsed.push(values);
    }
    return { values: parsed, fields: fields };
  }

  function isValidCron(expr) {
    return parseCron(expr) !== null;
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /** Every clock time the expression fires at, "HH:MM", in order. This is the
   * cross product, which is the whole point -- it is what the user needs to
   * see before saving. */
  function firingTimes(expr) {
    var parsed = parseCron(expr);
    if (!parsed) return null;
    var minutes = parsed.values[0];
    var hours = parsed.values[1];
    var times = [];
    for (var h = 0; h < hours.length; h++) {
      for (var m = 0; m < minutes.length; m++) {
        times.push(pad(hours[h]) + ":" + pad(minutes[m]));
      }
    }
    return times;
  }

  /** Contiguous runs of a sorted value list, rendered with `name`, so
   * [1,2,3,4,5] reads "Mon–Fri" rather than "Mon, Tue, Wed, Thu, Fri". */
  function summariseRuns(values, name) {
    var runs = [];
    for (var i = 0; i < values.length; i++) {
      var start = values[i];
      while (i + 1 < values.length && values[i + 1] === values[i] + 1) i++;
      runs.push(start === values[i] ? name(start) : name(start) + "–" + name(values[i]));
    }
    return runs.join(", ");
  }

  function joinTimes(times) {
    if (times.length === 1) return times[0];
    if (times.length <= 6) {
      return times.slice(0, -1).join(", ") + " and " + times[times.length - 1];
    }
    return times.length + " times a day, from " + times[0] + " to " + times[times.length - 1];
  }

  /** Plain-English rendering, or null if the expression is invalid. Says what
   * WILL happen, read off the parsed sets -- never off what the picker was
   * asked for. */
  function describeCron(expr) {
    var parsed = parseCron(expr);
    if (!parsed) return null;
    var dowAll = parsed.fields[4] === "*";
    var domAll = parsed.fields[2] === "*";
    var monthAll = parsed.fields[3] === "*";
    var when = joinTimes(firingTimes(expr));

    var dayParts = [];
    if (!dowAll) {
      dayParts.push(summariseRuns(parsed.values[4], function (d) { return DAY_NAMES[d]; }));
    }
    if (!domAll) {
      // Vixie cron ORs day-of-month with day-of-week when both are set, which
      // surprises people often enough to spell out here rather than in a
      // tooltip nobody opens.
      var days = "on day " + parsed.values[2].join(", ") + " of the month";
      dayParts.push(dowAll ? days : "or " + days);
    }
    if (!monthAll) {
      dayParts.push("in " + summariseRuns(parsed.values[3], function (m) { return MONTH_NAMES[m]; }));
    }
    var where = dayParts.length ? dayParts.join(" ") : "every day";
    return when + ", " + where + " (Oslo time)";
  }

  /** A sorted value list as a cron field, collapsing runs -- [1,2,3,4,5]
   * writes "1-5", not "1,2,3,4,5". The two mean the same thing to every
   * parser; the short one is what a person would have typed, and the compiled
   * expression is on screen and saved, so it may as well read like one. */
  function compileField(values) {
    if (!values.length) return "0";
    var parts = [];
    for (var i = 0; i < values.length; i++) {
      var start = values[i];
      while (i + 1 < values.length && values[i + 1] === values[i] + 1) i++;
      // A run of two writes shorter as "4,5" than as "4-5".
      parts.push(values[i] - start >= 2 ? start + "-" + values[i] : rangeAsList(start, values[i]));
    }
    return parts.join(",");
  }

  function rangeAsList(start, end) {
    var out = [];
    for (var v = start; v <= end; v++) out.push(v);
    return out.join(",");
  }

  /** Picker state -> expression. `days` is an array of 0–6 (empty or all
   * seven means every day); `times` is an array of "HH:MM". */
  function compileCron(days, times) {
    var minutes = {};
    var hours = {};
    for (var i = 0; i < times.length; i++) {
      var bits = String(times[i]).split(":");
      hours[Number(bits[0])] = true;
      minutes[Number(bits[1])] = true;
    }
    var minuteField = compileField(sortedKeys(minutes));
    var hourField = compileField(sortedKeys(hours));
    var dowField = !days.length || days.length === 7
      ? "*"
      : compileField(days.slice().sort(function (a, b) { return a - b; }));
    return minuteField + " " + hourField + " * * " + dowField;
  }

  function sortedKeys(set) {
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }

  /** Expression -> picker state, or null when the expression says something
   * the picker has no control for (a day-of-month or month restriction). The
   * form falls back to the raw box in that case rather than silently dropping
   * half the schedule, which is what an unconditional decode would do. */
  function decodeCron(expr) {
    var parsed = parseCron(expr);
    if (!parsed) return null;
    if (parsed.fields[2] !== "*" || parsed.fields[3] !== "*") return null;
    return {
      days: parsed.fields[4] === "*" ? [0, 1, 2, 3, 4, 5, 6] : parsed.values[4],
      times: firingTimes(expr),
    };
  }

  root.AgoraCron = {
    parseField: parseField,
    parseCron: parseCron,
    isValidCron: isValidCron,
    firingTimes: firingTimes,
    describeCron: describeCron,
    compileCron: compileCron,
    decodeCron: decodeCron,
  };
})(typeof window !== "undefined" ? window : globalThis);
