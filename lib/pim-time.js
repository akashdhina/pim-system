const OFFICE_TIME_ZONE = "Asia/Kolkata";

function officeParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: OFFICE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .map((part) => [part.type, part.value])
  );

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === "24" ? "00" : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function officeDate() {
  const parts = officeParts();
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function officeTime() {
  const parts = officeParts();
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function officeYear() {
  return officeDate().slice(0, 4);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00+05:30`);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateString}`);
  }

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

module.exports = {
  OFFICE_TIME_ZONE,
  addDays,
  officeDate,
  officeTime,
  officeYear,
};
