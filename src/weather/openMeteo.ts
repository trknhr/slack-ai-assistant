export interface WeatherForecastInput {
  location: string;
  date?: string;
  timezone?: string;
}

export interface WeatherForecast {
  locationName: string;
  country?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
  date: string;
  timezone: string;
  weatherCode: number;
  weatherDescription: string;
  temperatureMaxC?: number;
  temperatureMinC?: number;
  precipitationProbabilityMaxPct?: number;
  precipitationMm?: number;
  windSpeedMaxKmh?: number;
  umbrellaNote: string;
  summary: string;
}

export interface WeatherForecastProvider {
  getForecast(input: WeatherForecastInput): Promise<WeatherForecast>;
}

interface OpenMeteoGeocodingResponse {
  results?: Array<{
    name: string;
    country?: string;
    admin1?: string;
    latitude: number;
    longitude: number;
    timezone?: string;
  }>;
}

interface OpenMeteoForecastResponse {
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
    precipitation_sum?: number[];
    wind_speed_10m_max?: number[];
  };
}

const DEFAULT_TIMEZONE = "Asia/Tokyo";

export class OpenMeteoWeatherProvider implements WeatherForecastProvider {
  async getForecast(input: WeatherForecastInput): Promise<WeatherForecast> {
    const timezone = normalizeOptionalString(input.timezone) ?? DEFAULT_TIMEZONE;
    const date = input.date ?? currentDateInTimeZone(timezone);
    validateDateOnly(date);

    const location = await geocodeLocation(input.location);
    const forecast = await fetchForecast({
      latitude: location.latitude,
      longitude: location.longitude,
      timezone,
      date,
    });
    const daily = forecast.daily;
    const index = daily?.time?.indexOf(date) ?? -1;
    if (!daily || index < 0) {
      throw new Error(`Weather forecast for ${date} is unavailable.`);
    }

    const weatherCode = daily.weather_code?.[index];
    if (weatherCode === undefined) {
      throw new Error(`Weather forecast for ${date} did not include a weather code.`);
    }

    const temperatureMaxC = daily.temperature_2m_max?.[index];
    const temperatureMinC = daily.temperature_2m_min?.[index];
    const precipitationProbabilityMaxPct = daily.precipitation_probability_max?.[index];
    const precipitationMm = daily.precipitation_sum?.[index];
    const windSpeedMaxKmh = daily.wind_speed_10m_max?.[index];
    const weatherDescription = weatherCodeToJapanese(weatherCode);
    const umbrellaNote = buildUmbrellaNote(precipitationProbabilityMaxPct, precipitationMm, weatherCode);
    const summary = buildWeatherSummary({
      weatherDescription,
      temperatureMaxC,
      temperatureMinC,
      precipitationProbabilityMaxPct,
      umbrellaNote,
    });

    return {
      locationName: location.name,
      country: location.country,
      admin1: location.admin1,
      latitude: location.latitude,
      longitude: location.longitude,
      date,
      timezone,
      weatherCode,
      weatherDescription,
      temperatureMaxC,
      temperatureMinC,
      precipitationProbabilityMaxPct,
      precipitationMm,
      windSpeedMaxKmh,
      umbrellaNote,
      summary,
    };
  }
}

export function weatherCodeToJapanese(code: number): string {
  if (code === 0) return "快晴";
  if (code === 1) return "晴れ";
  if (code === 2) return "一部くもり";
  if (code === 3) return "くもり";
  if (code === 45 || code === 48) return "霧";
  if ([51, 53, 55].includes(code)) return "霧雨";
  if ([56, 57].includes(code)) return "着氷性の霧雨";
  if ([61, 63, 65].includes(code)) return "雨";
  if ([66, 67].includes(code)) return "着氷性の雨";
  if ([71, 73, 75].includes(code)) return "雪";
  if (code === 77) return "雪粒";
  if ([80, 81, 82].includes(code)) return "にわか雨";
  if ([85, 86].includes(code)) return "にわか雪";
  if (code === 95) return "雷雨";
  if (code === 96 || code === 99) return "ひょうを伴う雷雨";
  return "不明";
}

export function buildUmbrellaNote(
  precipitationProbabilityMaxPct: number | undefined,
  precipitationMm: number | undefined,
  weatherCode: number,
): string {
  if (isRainLikeWeatherCode(weatherCode) || (precipitationProbabilityMaxPct ?? 0) >= 50 || (precipitationMm ?? 0) >= 1) {
    return "傘があると安心です。";
  }
  if ((precipitationProbabilityMaxPct ?? 0) >= 30) {
    return "折りたたみ傘があると安心です。";
  }
  return "傘は不要そうです。";
}

function buildWeatherSummary(input: {
  weatherDescription: string;
  temperatureMaxC?: number;
  temperatureMinC?: number;
  precipitationProbabilityMaxPct?: number;
  umbrellaNote: string;
}): string {
  const temperature =
    input.temperatureMaxC !== undefined && input.temperatureMinC !== undefined
      ? `最高${roundOne(input.temperatureMaxC)}度/最低${roundOne(input.temperatureMinC)}度`
      : undefined;
  const precipitation =
    input.precipitationProbabilityMaxPct !== undefined
      ? `降水確率${Math.round(input.precipitationProbabilityMaxPct)}%`
      : undefined;
  return [input.weatherDescription, temperature, precipitation, input.umbrellaNote].filter(Boolean).join("、");
}

async function geocodeLocation(location: string): Promise<NonNullable<OpenMeteoGeocodingResponse["results"]>[number]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "ja");
  url.searchParams.set("format", "json");

  const payload = await fetchJson<OpenMeteoGeocodingResponse>(url);
  const first = payload.results?.[0];
  if (!first) {
    throw new Error(`Weather location '${location}' was not found.`);
  }
  return first;
}

async function fetchForecast(input: {
  latitude: number;
  longitude: number;
  timezone: string;
  date: string;
}): Promise<OpenMeteoForecastResponse> {
  const forecastDays = resolveForecastDays(input.date, input.timezone);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(input.latitude));
  url.searchParams.set("longitude", String(input.longitude));
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
      "precipitation_sum",
      "wind_speed_10m_max",
    ].join(","),
  );
  url.searchParams.set("timezone", input.timezone);
  url.searchParams.set("forecast_days", String(forecastDays));

  return fetchJson<OpenMeteoForecastResponse>(url);
}

async function fetchJson<T>(url: URL): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Weather API request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function resolveForecastDays(date: string, timezone: string): number {
  const today = currentDateInTimeZone(timezone);
  const days = daysBetween(today, date) + 1;
  if (days < 1) {
    throw new Error("Weather forecast date must be today or later.");
  }
  if (days > 16) {
    throw new Error("Weather forecast date must be within the next 16 days.");
  }
  return days;
}

function daysBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

function currentDateInTimeZone(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Unable to resolve current date for time zone ${timezone}.`);
  }
  return `${year}-${month}-${day}`;
}

function validateDateOnly(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error("Weather forecast date must be YYYY-MM-DD.");
  }
}

function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function roundOne(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function isRainLikeWeatherCode(code: number): boolean {
  return [
    51, 53, 55, 56, 57,
    61, 63, 65, 66, 67,
    71, 73, 75, 77,
    80, 81, 82, 85, 86,
    95, 96, 99,
  ].includes(code);
}
