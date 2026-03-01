/**
 * k6 load test: /functions/v1/register — push toward maximum requests per second.
 *
 * Goal: see what happens when the register API is hit at very high RPS.
 * Note: 1 million RPS from one machine is not realistic (CPU/network limits).
 * This script ramps VUs to find the max RPS your machine + API can handle.
 * For 1M+ RPS you need distributed load (e.g. k6 Cloud, many k6 runners).
 *
 * Prereqs:
 *   - Install k6: brew install k6
 *   - Start API: supabase functions serve register --no-verify-jwt
 *
 * Run:
 *   k6 run load-test/register-max-rps.js
 *   MAX_VUS=20000 k6 run load-test/register-max-rps.js   # push harder
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:54321';
const REGISTER_URL = `${BASE_URL}/functions/v1/register`;

const maxVUs = parseInt(__ENV.MAX_VUS || '10000', 10);

export const options = {
  scenarios: {
    ramp_then_sustained: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: Math.min(500, maxVUs) },
        { duration: '20s', target: Math.min(2000, maxVUs) },
        { duration: '20s', target: Math.min(5000, maxVUs) },
        { duration: '1m', target: maxVUs },
      ],
      gracefulRampDown: '20s',
      gracefulStop: '10s',
      startTime: '0s',
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<10000'],
    http_req_failed: ['rate<0.5'],
  },
};

export default function () {
  const res = http.post(REGISTER_URL, null, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'register' },
  });
  check(res, { 'register status 2xx': (r) => r.status >= 200 && r.status < 300 });
  // No sleep = maximum RPS per VU (limited by API response time)
  sleep(0);
}
