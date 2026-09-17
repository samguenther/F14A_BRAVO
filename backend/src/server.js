import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import morgan from 'morgan';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { InputError, AccessError } from './error.js';
import { getScore, compareScores, getRanking, getSeasonalScore, getMonthlyAverages } from './score.js';
import { processLocation } from './processing.js';
import { getAllLocations } from './db.js';
import { getGeopoliticalSummary } from './Geopolitical_Service.js';

import {
  requestLogger,
  errorLogger,
  healthHandler,
  metricsHandler,
} from './observability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(morgan(':method :url :status'));

app.use(requestLogger);

// Tracks whether startup data-seeding has finished. Score/ranking routes are
// gated on this so a cold start (e.g. after Render's free-tier disk resets
// or the instance spins down) never silently returns empty results while
// seeding is still in progress — it returns a clear 503 instead.
let dataReady = false;

// Block score/ranking routes (not /health or /metrics) until seeding has
// had a chance to run, instead of racing them against a cold start.
app.use((req, res, next) => {
  if (!dataReady && req.path.startsWith('/score')) {
    return res.status(503).json({ error: 'Server is warming up, please retry shortly.' });
  }
  next();
});

const catchErrors = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof InputError) {
      res.status(400).send({ error: err.message });
    } else if (err instanceof AccessError) {
      res.status(403).send({ error: err.message });
    } else {
      console.log(err);
      res.status(500).send({ error: 'A system error occurred' });
    }
  }
};

/***************************************************************
                       Health & Metrics
***************************************************************/

app.get('/', (req, res) => res.status(200).json({ status: 'ok', service: 'ClimateScore API' }));
app.get('/health', healthHandler);
app.get('/metrics', metricsHandler);

/***************************************************************
                       Processing
***************************************************************/

app.post(
  '/process',
  catchErrors(async (req, res) => {
    const result = await processLocation(req.body);
    return res.status(200).json(result);
  }),
);

/***************************************************************
                       Scores
***************************************************************/

app.get(
  '/score',
  catchErrors(async (req, res) => {
    const { country_code } = req.query;
    return res.status(200).json(await getScore(country_code));
  }),
);

app.get(
  '/score/compare',
  catchErrors(async (req, res) => {
    const codes = req.query.codes ? req.query.codes.split(',').map((c) => c.trim()) : [];
    return res.status(200).json({ results: await compareScores(codes) });
  }),
);

app.get(
  '/score/ranking',
  catchErrors(async (req, res) => {
    const { min_score, max_score, min_lat, max_lat, min_lon, max_lon } = req.query;
    const bounds =
      min_lat !== undefined
        ? {
            minLat: parseFloat(min_lat),
            maxLat: parseFloat(max_lat),
            minLon: parseFloat(min_lon),
            maxLon: parseFloat(max_lon),
          }
        : undefined;
    return res.status(200).json({
      results: await getRanking(
        min_score !== undefined ? parseFloat(min_score) : undefined,
        max_score !== undefined ? parseFloat(max_score) : undefined,
        bounds,
      ),
    });
  }),
);

app.get(
  '/score/seasonal',
  catchErrors(async (req, res) => {
    const { country_code } = req.query;
    return res.status(200).json(await getSeasonalScore(country_code));
  }),
);

app.get(
  '/score/monthly',
  catchErrors(async (req, res) => {
    const { country_code } = req.query;
    return res.status(200).json(await getMonthlyAverages(country_code));
  }),
);

app.get(
  '/score/geopolitical',
  catchErrors(async (req, res) => {
    const { country_code, months } = req.query;
    try {
      const result = await getGeopoliticalSummary(
        country_code,
        months !== undefined ? parseInt(months, 10) : 6,
      );
      return res.status(200).json(result);
    } catch (err) {
      if (err?.isCore5Error) {
        return res.status(503).json({ error: err.message });
      }
      throw err;
    }
  }),
);

/***************************************************************
                       Running Server
***************************************************************/

app.use(errorLogger);

const PORT = process.env.PORT || 5005;

const ensureSeeded = async () => {
  try {
    const locations = await getAllLocations();
    if (locations.length < 100) {
      console.log('No processed data found — running auto-seed...');
      const candidates = [
        join(__dirname, '..', 'raw_data.json'),
        join(__dirname, '..', '..', 'raw_data.json'),
      ];
      let rawPath = null;
      for (const c of candidates) {
        try {
          readFileSync(c, { encoding: 'utf-8', flag: 'r' }).slice(0, 1);
          rawPath = c;
          break;
        } catch { /* file not found */ }
      }
      if (!rawPath) {
        console.error('Auto-seed: could not find raw_data.json');
      } else {
        const raw = JSON.parse(readFileSync(rawPath, 'utf-8').replace(/^\uFEFF/, ''));
        console.log(`Auto-seeding ${raw.length} countries...`);
        for (const entry of raw) {
          try {
            await processLocation(entry);
            console.log(`Seeded ${entry.country_code}`);
          } catch (err) {
            console.warn(`Failed to seed ${entry.country_code}:`, err.message);
          }
        }
      }
      console.log('Auto-seed complete.');
    } else {
      console.log(`Found ${locations.length} locations — skipping seed.`);
    }
  } catch (err) {
    console.error('Auto-seed error:', err.message);
  } finally {
    // Even on failure, flip readiness so the API doesn't hang forever in a
    // "warming up" state — routes will just reflect whatever data exists.
    dataReady = true;
  }
};

const server = app.listen(PORT, async () => {
  console.log(`Backend listening on port ${PORT}`);

  if (process.env.NODE_ENV === 'test') {
    dataReady = true;
    return;
  }

  await ensureSeeded();
});

export default server;