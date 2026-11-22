import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Type } from "@google/genai";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { google } from "googleapis";

const WIDTH = 1080;
const HEIGHT = 1350;
const FONT_FILE = path.resolve("assets/rajdhani-v17-latin-600.woff2");
const FONT_EXISTS = fs.existsSync(FONT_FILE);
const REGISTERED_FAMILY = FONT_EXISTS
  ? GlobalFonts.registerFromPath(FONT_FILE, "Rajdhani")
  : null;
const FONT_FAMILY =
  (typeof REGISTERED_FAMILY === "string" && REGISTERED_FAMILY) ||
  (FONT_EXISTS ? "Rajdhani" : "sans-serif");

console.log("Rajdhani font exists:", FONT_EXISTS, "family:", FONT_FAMILY);

const BISON_ARMY_TOPICS = [
  "Why Motivation Fails",
  "How to Build Workout Discipline in 30 Days",
  "Why Most People Quit Their Fitness Goals",
  "The Power of Static Holds",
  "The Psychology of Workout Streaks",
  "How Long Does It Really Take to Build an Exercise Habit?",
  "What Happens When You Exercise for 15 Minutes Every Day?",
  "Never Miss Twice",
  "Why Calisthenics Builds Real-World Strength",
  "The Difference Between Training for Appearance and Performance",
  "Why Consistency Beats Intensity",
  "The Science of Daily Movement",
  "Why Stabilizer Muscles Matter More Than You Think",
  "The Identity Shift",
  "The Beginner's Guide to Calisthenics",
  "Why Discipline Beats Willpower Every Time",
  "How to Build a 15-Minute Daily Movement Habit",
  "The Truth About Static Holds and Tendon Strength",
  "Why You Don't Need a Gym for Real Strength",
  "How to Bounce Back After Breaking a Workout Streak",
  "Training for Longevity vs. Short-Term Burnout",
  "What Happens When You Train Before Checking Your Phone",
  "Why Boring Basics Outperform Fancy Workouts",
  "How to Stop Negotiating With Yourself on Tough Days",
  "The Role of Core Tension in Every Bodyweight Move",
  "Why Show-Up Days Matter More Than PR Days",
  "How Identity Shapes What You Do When Nobody Is Watching",
  "Mastering Push, Pull, and Hinge With Bodyweight",
  "Why Consistency Feels Slow Until Suddenly It Isn't",
  "Building a Routine You Can Keep When Life Gets Busy",
];
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY?.trim() });

function readHistory() {
  const filePath = path.resolve("history.json");
  if (!fs.existsSync(filePath)) return { usedTopics: [] };
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return {
    usedTopics: Array.isArray(parsed.usedTopics) ? parsed.usedTopics : [],
  };
}

function saveHistory(data) {
  fs.writeFileSync(
    path.resolve("history.json"),
    JSON.stringify(data, null, 2) + "\n"
  );
}

function pickNextTopic(usedTopics) {
  const usedSet = new Set(
    usedTopics.map((t) => String(t).trim().toLowerCase())
  );
  const remaining = BISON_ARMY_TOPICS.filter(
    (topic) => !usedSet.has(topic.toLowerCase())
  );

  // Once all 15 articles have been used, reset the cycle cleanly
  const pool = remaining.length > 0 ? remaining : BISON_ARMY_TOPICS;
  const cycleReset = remaining.length === 0;

  return {
    topic: pool[0],
    cycleReset,
  };
}

async function generateCarouselPlan(usedTopics) {
  const { topic: selectedTopic, cycleReset } = pickNextTopic(usedTopics);
  const models = ["gemini-3.5-flash-lite", "gemini-3.6-flash"];
  const attemptsPerModel = 2;

  const prompt = `You are the Content Strategist for Bison Army (bisonarmy.ca), a fitness and discipline platform focused on calisthenics, habit formation, workout consistency, identity building, psychology, and long-term health.
Core concepts to weave in naturally where fitting: Daily Missions, Workout Streaks, Discipline, Identity Building, Calisthenics, and 15-Minute Workouts.

Use this exact selected article topic: "${selectedTopic}"

Generate a 5-slide Instagram carousel package matching Bison Army's voice:
1. "topic": must be "${selectedTopic}"
2. "label": a short, punchy headline/hook (3-8 words) that sparks curiosity
3. "caption": 100-150 words, conversational tone, motivational yet evidence-based, Grade 6-8 reading level, mentions Bison Army naturally, includes a call-to-action to read the full article on Bison Army, and ends with a single engaging question
4. "hashtags": array of EXACTLY 5 strings, always including "#bisonarmy" plus 4 relevant tags (each starting with "#")
5. "slides": array of EXACTLY 5 objects (progressive lesson from Slide 1 to Slide 5, ending with a strong takeaway on Slide 5), each with:
  - "overlay_text": short title + 1-2 short sentences (keep it concise so it fits cleanly on a 1080x1350 slide, roughly 12-24 words total)
  - "photo_query": a clean 2-3 word stock photo search query (calisthenics, bodyweight training, gym, outdoor workout, focus, or discipline; no text or watermarks)`;

  const schemaConfig = {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING },
        label: { type: Type.STRING },
        caption: { type: Type.STRING },
        hashtags: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
        slides: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              overlay_text: { type: Type.STRING },
              photo_query: { type: Type.STRING },
            },
            required: ["overlay_text", "photo_query"],
          },
        },
      },
      required: ["topic", "label", "caption", "hashtags", "slides"],
    },
  };

  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            ...schemaConfig,
            abortSignal: AbortSignal.timeout(30000),
          },
        });

        const parsed = JSON.parse(response.text);
        const normalizedTags = Array.isArray(parsed.hashtags)
          ? parsed.hashtags
              .map((tag) => {
                const clean = String(tag).trim().replace(/^#+/, "");
                return clean ? `#${clean}` : null;
              })
              .filter(Boolean)
          : [];

        if (!normalizedTags.some((t) => t.toLowerCase() === "#bisonarmy")) {
          normalizedTags.unshift("#bisonarmy");
        }

        return {
          ...parsed,
          topic: selectedTopic,
          cycleReset,
          hashtags: normalizedTags.slice(0, 5),
        };
      } catch (err) {
        lastError = err;
        const msg = err?.message || String(err);
        console.warn(
          `[${model}] attempt ${attempt}/${attemptsPerModel} failed: ${msg}`
        );

        // No point retrying the same model if it isn't available (404)
        if (msg.includes("404")) {
          break;
        }

        const waitMs = 3000 * attempt + Math.floor(Math.random() * 1000);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  throw lastError;
}

function appendUtmParams(rawUrl, appName = "ig-carousel-bot") {
  if (!rawUrl) return "https://unsplash.com";
  const sep = rawUrl.includes("?") ? "&" : "?";
  return `${rawUrl}${sep}utm_source=${encodeURIComponent(
    appName
  )}&utm_medium=referral`;
}

async function fetchUnsplashPhoto(query, index) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY?.trim();
  if (!accessKey) {
    throw new Error("Missing UNSPLASH_ACCESS_KEY environment variable.");
  }

  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
    query
  )}&per_page=5&orientation=portrait`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${accessKey}`,
    },
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Unsplash request failed (${res.status}) for query "${query}": ${errBody}`
    );
  }

  const data = await res.json();
  const results = data.results || [];
  const photo = results[index % (results.length || 1)] || results[0];

  const imageUrl = photo?.urls?.regular || photo?.urls?.full;
  if (!imageUrl) {
    throw new Error(`No Unsplash photo found for "${query}"`);
  }

  // Trigger Unsplash download tracking endpoint per API guidelines
  if (photo.links?.download_location) {
    await fetch(photo.links.download_location, {
      headers: {
        Authorization: `Client-ID ${accessKey}`,
      },
    }).catch(() => {});
  }

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download Unsplash image (${imgRes.status})`);
  }

  const photographerName = photo.user?.name || "Unsplash Photographer";
  const profileUrl = appendUtmParams(
    photo.user?.links?.html || "https://unsplash.com"
  );

  return {
    buffer: Buffer.from(await imgRes.arrayBuffer()),
    creditLine: `Slide ${index + 1}: Photo by ${photographerName} on Unsplash (${profileUrl})`,
  };
}

function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  const totalHeight = lines.length * lineHeight;
  let startY = y - totalHeight / 2 + lineHeight / 2;

  for (const line of lines) {
    ctx.fillText(line, x, startY);
    startY += lineHeight;
  }
}

async function renderSlidePng(photoBuffer, overlayText, slideNum, totalSlides) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  const img = await loadImage(photoBuffer);
  const scale = Math.max(WIDTH / img.width, HEIGHT / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const drawX = (WIDTH - drawW) / 2;
  const drawY = (HEIGHT - drawH) / 2;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  // Dark gradient over the photo
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, "rgba(0, 0, 0, 0.45)");
  grad.addColorStop(0.5, "rgba(0, 0, 0, 0.6)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0.7)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Backing box behind main text for strong contrast
  ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
  ctx.fillRect(70, HEIGHT / 2 - 220, WIDTH - 140, 440);

  // Main overlay text centered (weight 600 to match the woff2 file)
  const safeText = String(overlayText || "").trim() || "Bison Army";
  ctx.fillStyle = "#FFFFFF";
  ctx.font = `600 48px "${FONT_FAMILY}", sans-serif`;
  ctx.textAlign = "center";
  drawWrappedText(ctx, safeText, WIDTH / 2, HEIGHT / 2, WIDTH - 200, 64);

  return canvas.toBuffer("image/png");
}
function getDriveClient() {
  const clientId = process.env.GDRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.GDRIVE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GDRIVE_REFRESH_TOKEN?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, or GDRIVE_REFRESH_TOKEN."
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.drive({ version: "v3", auth: oauth2Client });
}

async function createDriveSubfolder(drive, parentId, folderName) {
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });
  return res.data.id;
}

async function uploadFileToDrive(drive, filePath, mimeType, folderId) {
  const fileName = path.basename(filePath);
  await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: "id",
  });
}

async function main() {
  const folderId = process.env.GDRIVE_FOLDER_ID?.trim();
  if (!folderId) {
    throw new Error("Missing GDRIVE_FOLDER_ID environment variable.");
  }

  const history = readHistory();
  const plan = await generateCarouselPlan(history.usedTopics);
  const slides = plan.slides.slice(0, 5);

  const dateTag = new Date().toISOString().slice(0, 10);
  const localDir = path.resolve("tmp_output", dateTag);
  fs.mkdirSync(localDir, { recursive: true });

  const uploadedFiles = [];
  const photoCredits = [];

  for (let i = 0; i < slides.length; i++) {
    const slideNum = i + 1;
    const { buffer: photoBuf, creditLine } = await fetchUnsplashPhoto(
      slides[i].photo_query,
      i
    );
    photoCredits.push(creditLine);

    const pngBuf = await renderSlidePng(
      photoBuf,
      slides[i].overlay_text,
      slideNum,
      slides.length
    );
    const outFile = path.join(localDir, `slide-${slideNum}.png`);
    fs.writeFileSync(outFile, pngBuf);
    uploadedFiles.push({ filePath: outFile, mimeType: "image/png" });
  }

  const hashtagLine = plan.hashtags.join(" ");
  const fullCaption = `${plan.caption}\n\n${hashtagLine}`;

  const captionFile = path.join(localDir, "caption.txt");
  fs.writeFileSync(
    captionFile,
    `Topic: ${plan.topic}\nLabel: ${plan.label || ""}\n\n${fullCaption}\n\nPhoto Credits:\n${photoCredits.join(
      "\n"
    )}\n\nSlide Texts:\n${slides
      .map((s, idx) => `${idx + 1}. ${s.overlay_text}`)
      .join("\n")}\n`
  );
  uploadedFiles.push({ filePath: captionFile, mimeType: "text/plain" });

  const drive = getDriveClient();
  const subfolderId = await createDriveSubfolder(
    drive,
    folderId,
    `${dateTag} - ${plan.topic.slice(0, 40)}`
  );

  for (const item of uploadedFiles) {
    await uploadFileToDrive(drive, item.filePath, item.mimeType, subfolderId);
  }

  // Start a fresh history cycle if all 15 topics were already used
  history.usedTopics = plan.cycleReset
    ? [plan.topic]
    : [...history.usedTopics, plan.topic];
  saveHistory(history);

  console.log(
    `Uploaded carousel for topic "${plan.topic}" to Google Drive folder ${subfolderId}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
