require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'attendance-data.json');

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// Helper to convert ISO UTC string to IST (Asia/Kolkata)
function formatIST(isoString) {
  if (!isoString) return null;
  return new Date(isoString).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const store = new Map();
      for (const [eventId, participantsObj] of Object.entries(parsed)) {
        store.set(eventId, new Map(Object.entries(participantsObj)));
      }
      return store;
    }
  } catch (err) {
    console.error('Failed to load attendance-data.json:', err.message);
  }
  return new Map();
}

function saveStore(store) {
  const plain = {};
  for (const [eventId, participantsMap] of store.entries()) {
    plain[eventId] = Object.fromEntries(participantsMap.entries());
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(plain, null, 2), 'utf8');
}

const attendanceStore = loadStore();

async function getZoomAccessToken() {
  const credentials = Buffer.from(
    `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Zoom Auth Error: ${await response.text()}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function zoomGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// Schedule a Meeting (Free Tier)
app.post('/api/zoom/meetings', async (req, res) => {
  try {
    const token = await getZoomAccessToken();
    const { topic, start_time, duration } = req.body;

    const response = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        topic: topic || 'Scheduled Meeting',
        type: 2,
        start_time: start_time || new Date(Date.now() + 3600000).toISOString(),
        duration: duration || 30,
        timezone: 'Asia/Kolkata',
        settings: {
          join_before_host: true,
          waiting_room: false,
        },
      }),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// List Upcoming Meetings (Free Tier)
app.get('/api/zoom/meetings', async (req, res) => {
  try {
    const token = await getZoomAccessToken();
    const response = await fetch(
      'https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=30',
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// Webhook Listener: Captures exact join & leave timestamps across multiple sessions
app.post('/api/zoom/webhook', (req, res) => {
  const { event, payload } = req.body;

  if (event === 'endpoint.url_validation') {
    const hashForValidate = crypto
      .createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
      .update(payload.plainToken)
      .digest('hex');

    return res.status(200).json({
      plainToken: payload.plainToken,
      encryptedToken: hashForValidate,
    });
  }

  const signature = req.headers['x-zm-signature'];
  const timestamp = req.headers['x-zm-request-timestamp'];
  if (signature && timestamp && process.env.ZOOM_WEBHOOK_SECRET_TOKEN) {
    const message = `v0:${timestamp}:${req.rawBody}`;
    const expectedSig =
      'v0=' +
      crypto
        .createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(message)
        .digest('hex');

    if (signature !== expectedSig) {
      return res.status(401).json({ status: 'error', message: 'Invalid webhook signature' });
    }
  }

  const eventId = String(payload?.object?.id || '').replace(/\s+/g, '');
  const participant = payload?.object?.participant;

  if (eventId && participant) {
    if (!attendanceStore.has(eventId)) {
      attendanceStore.set(eventId, new Map());
    }
    const eventMap = attendanceStore.get(eventId);

    const isGuest = !participant.email;
    const key = participant.email
      ? participant.email.toLowerCase()
      : `guest_${participant.user_id || participant.participant_uuid || participant.user_name}`;

    if (
      event === 'meeting.participant_joined' ||
      event === 'webinar.participant_joined'
    ) {
      const existing = eventMap.get(key) || {
        name: participant.user_name || 'Guest',
        email: participant.email ? participant.email.toLowerCase() : null,
        is_guest: isGuest,
        sessions: [],
      };

      existing.sessions.push({
        join_time_utc: participant.join_time || new Date().toISOString(),
        leave_time_utc: null,
      });

      eventMap.set(key, existing);
      saveStore(attendanceStore);
    } else if (
      event === 'meeting.participant_left' ||
      event === 'webinar.participant_left'
    ) {
      const existing = eventMap.get(key) || {
        name: participant.user_name || 'Guest',
        email: participant.email ? participant.email.toLowerCase() : null,
        is_guest: isGuest,
        sessions: [{ join_time_utc: null, leave_time_utc: null }],
      };

      const lastSession = existing.sessions[existing.sessions.length - 1];
      if (lastSession && !lastSession.leave_time_utc) {
        lastSession.leave_time_utc = participant.leave_time || new Date().toISOString();
      } else {
        existing.sessions.push({
          join_time_utc: null,
          leave_time_utc: participant.leave_time || new Date().toISOString(),
        });
      }

      eventMap.set(key, existing);
      saveStore(attendanceStore);
    }
  }

  return res.status(200).send('OK');
});

// Attendance Endpoint with Join/Leave History
app.get('/api/zoom/attendance', async (req, res) => {
  try {
    const { type = 'meeting', id } = req.query;

    if (!id || !['meeting', 'webinar'].includes(type)) {
      return res.status(400).json({
        status: 'error',
        message: 'Provide valid query params: ?type=meeting|webinar&id=EVENT_ID',
      });
    }

    const cleanId = id.replace(/\s+/g, '');
    const token = await getZoomAccessToken();

    const detailsUrl =
      type === 'webinar'
        ? `https://api.zoom.us/v2/webinars/${cleanId}`
        : `https://api.zoom.us/v2/meetings/${cleanId}`;

    const detailsRes = await zoomGet(detailsUrl, token);
    const invitees = detailsRes.ok ? detailsRes.data?.settings?.meeting_invitees || [] : [];

    const recordedMap = attendanceStore.get(cleanId) || new Map();
    const present = Array.from(recordedMap.values()).map((p) => {
      let totalSeconds = 0;
      const sessions = (p.sessions || []).map((s) => {
        const sec =
          s.join_time_utc && s.leave_time_utc
            ? Math.max(0, Math.round((new Date(s.leave_time_utc) - new Date(s.join_time_utc)) / 1000))
            : 0;
        totalSeconds += sec;

        return {
          joined_at_ist: formatIST(s.join_time_utc),
          left_at_ist: formatIST(s.leave_time_utc),
          join_time_utc: s.join_time_utc,
          leave_time_utc: s.leave_time_utc,
          session_duration_seconds: sec,
        };
      });

      return {
        name: p.name,
        email: p.email,
        is_guest: p.is_guest,
        first_joined_ist: sessions[0]?.joined_at_ist || null,
        last_left_ist: sessions[sessions.length - 1]?.left_at_ist || null,
        total_duration_seconds: totalSeconds,
        sessions,
      };
    });

    const guestCount = present.filter((p) => p.is_guest).length;
    const presentEmails = new Set(present.map((p) => p.email).filter(Boolean));

    const absent = invitees
      .filter((inv) => inv.email && !presentEmails.has(inv.email.toLowerCase()))
      .map((inv) => ({
        name: inv.email,
        email: inv.email.toLowerCase(),
      }));

    return res.json({
      status: 'success',
      type,
      event: detailsRes.ok
        ? {
            id: cleanId,
            topic: detailsRes.data.topic,
            start_time: detailsRes.data.start_time,
            duration_minutes: detailsRes.data.duration,
          }
        : { id: cleanId, note: 'Event details unavailable on current Zoom license or simulated ID' },
      summary: {
        total_invited: invitees.length,
        total_present: present.length,
        authenticated_users: present.length - guestCount,
        guest_users: guestCount,
        total_absent: absent.length,
      },
      present,
      absent,
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});