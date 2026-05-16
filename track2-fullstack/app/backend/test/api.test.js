const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmtracker-test-'));
process.env.FARMTRACKER_DB_PATH = path.join(tempDir, 'farmtracker.db');

const app = require('../server');
const { db } = require('../db');

let server;
let baseUrl;

before(async () => {
  seedTestData();
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedTestData() {
  db.exec('DELETE FROM weights; DELETE FROM health_events; DELETE FROM animals; DELETE FROM paddocks;');

  const northId = db.prepare(
    'INSERT INTO paddocks (name, capacity, animal_count) VALUES (?, ?, 0)'
  ).run('North Paddock', 50).lastInsertRowid;

  const southId = db.prepare(
    'INSERT INTO paddocks (name, capacity, animal_count) VALUES (?, ?, 0)'
  ).run('South Paddock', 30).lastInsertRowid;

  const insertAnimal = db.prepare(
    'INSERT INTO animals (name, tag_number, breed, date_of_birth, paddock_id) VALUES (?, ?, ?, ?, ?)'
  );

  const bellaId = insertAnimal.run('Bella', 'TAG-001', 'Merino', '2021-03-14', northId).lastInsertRowid;
  insertAnimal.run('Daisy', 'TAG-002', 'Dorper', '2020-07-22', southId);

  db.prepare('UPDATE paddocks SET animal_count = animal_count + 1 WHERE id = ?').run(northId);
  db.prepare('UPDATE paddocks SET animal_count = animal_count + 1 WHERE id = ?').run(southId);

  db.prepare(
    'INSERT INTO health_events (animal_id, event_type, notes, date, vet_name) VALUES (?, ?, ?, ?, ?)'
  ).run(bellaId, 'vaccination', 'Routine vaccination', '2024-01-15', 'Dr. Walsh');
}

async function get(path) {
  const res = await fetch(baseUrl + path);
  return { status: res.status, body: await res.json() };
}

async function post(path, body) {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function put(path, body) {
  const res = await fetch(baseUrl + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /api/paddocks returns an array', async () => {
  const { status, body } = await get('/paddocks');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
});

test('GET /api/animals returns animals with latest_health_event field', async () => {
  const { status, body } = await get('/animals?page=0&limit=5');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 0);
  assert.ok('latest_health_event' in body[0]);
});

test('GET /api/animals uses page as a page number', async () => {
  const { body: firstPage } = await get('/animals?page=0&limit=1');
  const { body: secondPage } = await get('/animals?page=1&limit=1');

  assert.equal(firstPage.length, 1);
  assert.equal(secondPage.length, 1);
  assert.notEqual(firstPage[0].id, secondPage[0].id);
});

test('GET /api/animals/:id returns a single animal', async () => {
  const { body: animals } = await get('/animals?page=0&limit=1');
  const id = animals[0].id;
  const { status, body } = await get(`/animals/${id}`);
  assert.equal(status, 200);
  assert.equal(body.id, id);
});

test('GET /api/animals/:id returns 404 for unknown id', async () => {
  const { status } = await get('/animals/999999');
  assert.equal(status, 404);
});

test('POST /api/animals creates an animal with 201 and updates paddock count', async () => {
  const { body: paddocksBefore } = await get('/paddocks');
  const north = paddocksBefore.find(p => p.name === 'North Paddock');

  const { status, body } = await post('/animals', {
    name: 'Maple',
    tag_number: 'TAG-NEW-001',
    breed: 'Merino',
    paddock_id: north.id,
  });

  assert.equal(status, 201);
  assert.equal(body.name, 'Maple');
  assert.equal(body.paddock_id, north.id);

  const { body: paddocksAfter } = await get('/paddocks');
  const updatedNorth = paddocksAfter.find(p => p.id === north.id);
  assert.equal(updatedNorth.animal_count, north.animal_count + 1);
});

test('POST /api/animals rejects an unknown paddock', async () => {
  const { status } = await post('/animals', {
    name: 'Ghost',
    tag_number: 'TAG-GHOST',
    paddock_id: 999999,
  });

  assert.equal(status, 404);
});

test('PUT /api/animals/:id keeps paddock counts consistent when moving animals', async () => {
  const { body: paddocksBefore } = await get('/paddocks');
  const north = paddocksBefore.find(p => p.name === 'North Paddock');
  const south = paddocksBefore.find(p => p.name === 'South Paddock');
  const { body: animals } = await get('/animals?page=0&limit=20');
  const animal = animals.find(a => a.paddock_id === north.id);

  const { status, body } = await put(`/animals/${animal.id}`, {
    ...animal,
    paddock_id: south.id,
  });

  assert.equal(status, 200);
  assert.equal(body.paddock_id, south.id);

  const { body: paddocksAfter } = await get('/paddocks');
  assert.equal(
    paddocksAfter.find(p => p.id === north.id).animal_count,
    north.animal_count - 1
  );
  assert.equal(
    paddocksAfter.find(p => p.id === south.id).animal_count,
    south.animal_count + 1
  );
});

test('POST /api/animals/:id/health-events creates an event', async () => {
  const { body: animals } = await get('/animals?page=0&limit=1');
  const id = animals[0].id;
  const { status, body } = await post(`/animals/${id}/health-events`, {
    event_type: 'checkup',
    date: '2025-01-10',
    vet_name: 'Dr. Test',
  });
  assert.equal(status, 201);
  assert.equal(body.event_type, 'checkup');
  assert.equal(body.animal_id, id);
});

test('POST /api/animals/:id/weights creates a weight record', async () => {
  const { body: animals } = await get('/animals?page=0&limit=1');
  const id = animals[0].id;
  const { status, body } = await post(`/animals/${id}/weights`, {
    weight_kg: 45.2,
    date: '2024-11-15',
    notes: 'Post-shearing weigh-in',
  });

  assert.equal(status, 201);
  assert.equal(body.animal_id, id);
  assert.equal(body.weight_kg, 45.2);
  assert.equal(body.date, '2024-11-15');
  assert.equal(body.notes, 'Post-shearing weigh-in');
});

test('POST /api/animals/:id/weights validates positive weight', async () => {
  const { body: animals } = await get('/animals?page=0&limit=1');
  const id = animals[0].id;

  const missing = await post(`/animals/${id}/weights`, {
    date: '2024-11-15',
  });
  const negative = await post(`/animals/${id}/weights`, {
    weight_kg: -1,
    date: '2024-11-15',
  });

  assert.equal(missing.status, 422);
  assert.equal(negative.status, 422);
});

test('POST /api/animals/:id/weights returns 404 for unknown animals', async () => {
  const { status } = await post('/animals/999999/weights', {
    weight_kg: 45.2,
    date: '2024-11-15',
  });

  assert.equal(status, 404);
});

test('GET /api/animals/:id/weights returns history by date descending', async () => {
  const { body: animals } = await get('/animals?page=0&limit=1');
  const id = animals[0].id;

  await post(`/animals/${id}/weights`, {
    weight_kg: 42.1,
    date: '2024-09-01',
  });
  await post(`/animals/${id}/weights`, {
    weight_kg: 44.8,
    date: '2024-12-01',
  });

  const { status, body } = await get(`/animals/${id}/weights`);
  assert.equal(status, 200);
  assert.ok(body.length >= 2);
  assert.deepEqual(
    body.map(weight => weight.date),
    [...body.map(weight => weight.date)].sort().reverse()
  );
});
