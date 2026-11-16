require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// 1. Get Zoom Server-to-Server OAuth Token
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

// Helper for Zoom GET calls
async function zoomGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// 2. Main Endpoint: GET /api/zoom/attendance?type=meeting|webinar&id=EVENT_ID
app.get('/api/zoom/attendance', async (req, res) => {
  try {
    const { type, id } = req.query;

    if (!id || !['meeting', 'webinar'].includes(type)) {
      return res.status(400).json({
        status: 'error',
        message: 'Provide valid query params: ?type=meeting|webinar&id=EVENT_ID',
      });
    }

    const cleanId = id.replace(/\s+/g, '');
    const token = await getZoomAccessToken();

    // A. Fetch Present Participants (with join & leave times)
    const reportUrl =
      type === 'webinar'
        ? `https://api.zoom.us/v2/report/webinars/${cleanId}/participants?page_size=300`
        : `https://api.zoom.us/v2/report/meetings/${cleanId}/participants?page_size=300`;

    const participantsRes = await zoomGet(reportUrl, token);

    if (!participantsRes.ok) {
      return res.status(participantsRes.status).json({
        status: 'error',
        message: participantsRes.data.message || 'Failed to fetch participants',
      });
    }

    const present = (participantsRes.data.participants || []).map((p) => ({
      name: p.name || 'Guest',
      email: (p.user_email || '').toLowerCase() || null,
      join_time: p.join_time || null,
      leave_time: p.leave_time || null,
      duration_seconds: p.duration || 0,
    }));

    const presentEmails = new Set(present.map((p) => p.email).filter(Boolean));

    // B. Fetch Absent List
    let absent = [];

    if (type === 'webinar') {
      // Zoom provides a direct absentees endpoint for webinars
      const absenteesRes = await zoomGet(
        `https://api.zoom.us/v2/past_webinars/${cleanId}/absentees?page_size=300`,
        token
      );
      if (absenteesRes.ok) {
        absent = (absenteesRes.data.registrants || []).map((r) => ({
          name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Registrant',
          email: r.email || null,
        }));
      }
    } else {
      // For meetings, compare Approved Registrants + Meeting Invitees against Present emails
      const expectedMap = new Map();

      // 1) Check Meeting Registrants (if registration was enabled)
      const regRes = await zoomGet(
        `https://api.zoom.us/v2/meetings/${cleanId}/registrants?status=approved&page_size=300`,
        token
      );
      if (regRes.ok && regRes.data.registrants) {
        for (const r of regRes.data.registrants) {
          if (r.email) {
            expectedMap.set(r.email.toLowerCase(), {
              name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email,
              email: r.email.toLowerCase(),
            });
          }
        }
      }

      // 2) Check Calendar/Zoom Meeting Invitees (if invited via email)
      const detailsRes = await zoomGet(`https://api.zoom.us/v2/meetings/${cleanId}`, token);
      const invitees = detailsRes.data?.settings?.meeting_invitees || [];
      for (const inv of invitees) {
        if (inv.email && !expectedMap.has(inv.email.toLowerCase())) {
          expectedMap.set(inv.email.toLowerCase(), {
            name: inv.email,
            email: inv.email.toLowerCase(),
          });
        }
      }

      // Anyone in expectedMap who is NOT in presentEmails is absent
      for (const [email, person] of expectedMap.entries()) {
        if (!presentEmails.has(email)) {
          absent.push(person);
        }
      }
    }

    return res.json({
      status: 'success',
      type,
      event_id: cleanId,
      summary: {
        total_present: present.length,
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