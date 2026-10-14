// Previsioni del tempo per le giornate del viaggio, da Open-Meteo (gratuito, senza chiave,
// dati CC BY 4.0). Le previsioni arrivano fino a 16 giorni: oltre si indica da quando ci saranno.

export const OPENMETEO_URL = process.env.OPENMETEO_URL || 'https://api.open-meteo.com';
const DAYS = 16;
const TTL = 3 * 3600e3;            // le previsioni cambiano: cache di 3 ore

// Codici WMO del tempo → descrizione e simbolo
const WMO = [
  [[0], 'sereno', '☀'], [[1], 'poco nuvoloso', '🌤'], [[2], 'parzialmente nuvoloso', '⛅'], [[3], 'coperto', '☁'],
  [[45, 48], 'nebbia', '🌫'], [[51, 53, 55, 56, 57], 'pioviggine', '🌦'], [[61, 63, 80, 81], 'pioggia', '🌧'],
  [[65, 82], 'pioggia forte', '🌧'], [[66, 67], 'pioggia gelata', '🌧'], [[71, 73, 77, 85], 'neve', '🌨'],
  [[75, 86], 'neve forte', '❄'], [[95], 'temporale', '⛈'], [[96, 99], 'temporale con grandine', '⛈']
];
export function describe(code) {
  const w = WMO.find(([c]) => c.includes(code));
  return w ? { text: w[1], icon: w[2] } : { text: 'n.d.', icon: '·' };
}

// Avvisi utili a chi guida un camper: vento forte (mezzo alto e leggero), neve, ghiaccio, temporali.
export function warningsFor(d) {
  const w = [];
  if (d.gusts >= 70) w.push(`raffiche fino a ${d.gusts} km/h: guida prudente, attenzione a ponti e viadotti`);
  else if (d.gusts >= 50) w.push(`vento a raffiche (${d.gusts} km/h)`);
  if ([71, 73, 75, 77, 85, 86].includes(d.code)) w.push('neve: catene o gomme invernali');
  else if (d.tmin != null && d.tmin <= 0) w.push('possibile ghiaccio al mattino');
  if ([95, 96, 99].includes(d.code)) w.push('temporali');
  if (d.rain >= 20) w.push(`pioggia abbondante (${d.rain} mm)`);
  if (d.tmax >= 35) w.push('molto caldo: meglio una sosta all\'ombra o con corrente');
  return w;
}

export function createWeather({ fetchJson }) {
  const cache = new Map();     // cella 0,1° → {at, daily}

  async function forecast(lat, lon) {
    const key = `${lat.toFixed(1)}_${lon.toFixed(1)}`;
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL) return c.daily;
    const url = `${OPENMETEO_URL}/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max' +
      `&timezone=auto&forecast_days=${DAYS}`;
    const d = await fetchJson(url, {}, 20000);
    if (!d?.daily?.time) throw new Error('risposta non valida da Open-Meteo');
    cache.set(key, { at: Date.now(), daily: d.daily });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return d.daily;
  }

  // points: [{lat, lon, date: 'AAAA-MM-GG'}] → stesso ordine, ogni voce {date, ...} oppure {date, missing}
  async function forDays(points) {
    const today = new Date().toISOString().slice(0, 10);
    const last = new Date(Date.now() + (DAYS - 1) * 864e5).toISOString().slice(0, 10);
    const out = [];
    let error = '';
    for (const p of points) {
      if (!p.date) { out.push({ missing: 'nodate' }); continue; }
      if (p.date < today) { out.push({ date: p.date, missing: 'past' }); continue; }
      if (p.date > last) {
        out.push({ date: p.date, missing: 'later', from: new Date(Date.parse(p.date + 'T12:00:00Z') - (DAYS - 1) * 864e5).toISOString().slice(0, 10) });
        continue;
      }
      try {
        const daily = await forecast(p.lat, p.lon);
        const i = daily.time.indexOf(p.date);
        if (i < 0) { out.push({ date: p.date, missing: 'later' }); continue; }
        const r = v => v == null ? null : Math.round(v);
        const day = {
          date: p.date, code: daily.weather_code[i],
          tmax: r(daily.temperature_2m_max[i]), tmin: r(daily.temperature_2m_min[i]),
          rain: daily.precipitation_sum[i] == null ? null : +daily.precipitation_sum[i].toFixed(1),
          rainProb: r(daily.precipitation_probability_max?.[i]),
          wind: r(daily.wind_speed_10m_max[i]), gusts: r(daily.wind_gusts_10m_max[i])
        };
        out.push({ ...day, ...describe(day.code), warnings: warningsFor(day) });
      } catch (e) { error ||= e.message; out.push({ date: p.date, missing: 'error' }); }
    }
    return { days: out, error };
  }

  return { forDays };
}
