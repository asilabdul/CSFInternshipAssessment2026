const express = require('express');
const router = express.Router();
const { db } = require('../db');

function getAnimal(id) {
  return db.prepare('SELECT * FROM animals WHERE id = ?').get(id);
}

function normalizePaddockId(paddockId) {
  if (paddockId === null || paddockId === undefined || paddockId === '') {
    return null;
  }
  const normalized = Number(paddockId);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : NaN;
}

function validatePaddockAssignment(paddockId, currentPaddockId = null) {
  const normalizedPaddockId = normalizePaddockId(paddockId);
  if (Number.isNaN(normalizedPaddockId)) {
    return { error: 'paddock_id must be a positive integer', status: 422 };
  }
  if (normalizedPaddockId === null || normalizedPaddockId === currentPaddockId) {
    return { paddockId: normalizedPaddockId };
  }

  const paddock = db.prepare('SELECT * FROM paddocks WHERE id = ?').get(normalizedPaddockId);
  if (!paddock) {
    return { error: 'Paddock not found', status: 404 };
  }
  if (paddock.animal_count >= paddock.capacity) {
    return { error: 'Paddock is at capacity', status: 422 };
  }

  return { paddockId: normalizedPaddockId };
}

router.get('/', (req, res) => {
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = page * limit;

  const animals = db.prepare(
    'SELECT * FROM animals LIMIT ? OFFSET ?'
  ).all(limit, offset);

  const result = animals.map(animal => {
    const latestEvent = db.prepare(`
      SELECT * FROM health_events
      WHERE animal_id = ?
      ORDER BY date DESC
      LIMIT 1
    `).get(animal.id);
    return { ...animal, latest_health_event: latestEvent ?? null };
  });

  res.json(result);
});

router.post('/', (req, res) => {
  const { name, tag_number, breed, date_of_birth, paddock_id } = req.body;

  if (!name || !tag_number) {
    return res.status(400).json({ error: 'name and tag_number are required' });
  }

  const assignment = validatePaddockAssignment(paddock_id);
  if (assignment.error) {
    return res.status(assignment.status).json({ error: assignment.error });
  }

  db.exec('BEGIN');
  try {
    if (assignment.paddockId) {
      db.prepare(
        'UPDATE paddocks SET animal_count = animal_count + 1 WHERE id = ?'
      ).run(assignment.paddockId);
    }

    const result = db.prepare(
      'INSERT INTO animals (name, tag_number, breed, date_of_birth, paddock_id) VALUES (?, ?, ?, ?, ?)'
    ).run(name, tag_number, breed ?? null, date_of_birth ?? null, assignment.paddockId);

    const animal = db.prepare('SELECT * FROM animals WHERE id = ?').get(result.lastInsertRowid);
    db.exec('COMMIT');
    res.status(201).json(animal);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

router.get('/:id', (req, res) => {
  const animal = getAnimal(req.params.id);
  if (!animal) return res.status(404).json({ error: 'Animal not found' });
  res.json(animal);
});

router.put('/:id', (req, res) => {
  const animal = getAnimal(req.params.id);
  if (!animal) return res.status(404).json({ error: 'Animal not found' });

  const requestedPaddockId = 'paddock_id' in req.body ? req.body.paddock_id : animal.paddock_id;
  const assignment = validatePaddockAssignment(requestedPaddockId, animal.paddock_id);
  if (assignment.error) {
    return res.status(assignment.status).json({ error: assignment.error });
  }

  const updates = {
    name:          req.body.name          ?? animal.name,
    tag_number:    req.body.tag_number    ?? animal.tag_number,
    breed:         req.body.breed         ?? animal.breed,
    date_of_birth: req.body.date_of_birth ?? animal.date_of_birth,
    paddock_id:    assignment.paddockId,
  };

  db.exec('BEGIN');
  try {
    if (updates.paddock_id !== animal.paddock_id) {
      if (animal.paddock_id) {
        db.prepare(
          'UPDATE paddocks SET animal_count = animal_count - 1 WHERE id = ?'
        ).run(animal.paddock_id);
      }
      if (updates.paddock_id) {
        db.prepare(
          'UPDATE paddocks SET animal_count = animal_count + 1 WHERE id = ?'
        ).run(updates.paddock_id);
      }
    }

    db.prepare(`
      UPDATE animals
      SET name = ?, tag_number = ?, breed = ?, date_of_birth = ?, paddock_id = ?
      WHERE id = ?
    `).run(updates.name, updates.tag_number, updates.breed, updates.date_of_birth, updates.paddock_id, req.params.id);

    const updated = db.prepare('SELECT * FROM animals WHERE id = ?').get(req.params.id);
    db.exec('COMMIT');
    res.json(updated);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

router.delete('/:id', (req, res) => {
  const animal = getAnimal(req.params.id);
  if (!animal) return res.status(404).json({ error: 'Animal not found' });

  db.exec('BEGIN');
  try {
    if (animal.paddock_id) {
      db.prepare(
        'UPDATE paddocks SET animal_count = animal_count - 1 WHERE id = ?'
      ).run(animal.paddock_id);
    }

    db.prepare('DELETE FROM animals WHERE id = ?').run(req.params.id);
    db.exec('COMMIT');
    res.json({ message: 'deleted' });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});

router.get('/:id/health-events', (req, res) => {
  const animal = getAnimal(req.params.id);
  if (!animal) return res.status(404).json({ error: 'Animal not found' });

  const events = db.prepare(
    'SELECT * FROM health_events WHERE animal_id = ? ORDER BY date DESC'
  ).all(req.params.id);
  res.json(events);
});

router.post('/:id/health-events', (req, res) => {
  const animal = getAnimal(req.params.id);
  if (!animal) return res.status(404).json({ error: 'Animal not found' });

  const { event_type, notes, date, vet_name } = req.body;
  if (!event_type || !date) {
    return res.status(400).json({ error: 'event_type and date are required' });
  }

  const result = db.prepare(
    'INSERT INTO health_events (animal_id, event_type, notes, date, vet_name) VALUES (?, ?, ?, ?, ?)'
  ).run(req.params.id, event_type, notes ?? null, date, vet_name ?? null);

  const event = db.prepare('SELECT * FROM health_events WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(event);
});

module.exports = router;
