import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Type } from "@google/genai";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { google } from "googleapis";

const WIDTH = 1080;
const HEIGHT = 1350;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function readHistory() {
  const filePath = path.resolve("history.json");
  if (!fs.existsSync(filePath)) return { usedTopics: [] };
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveHistory(data) {
  fs.writeFileSync(path.resolve("history.json"), JSON.stringify(data, null, 2) + "\n");
}

async function generateCarouselPlan(usedTopics) {
  const recentTopics = usedTopics.slice(-50).join(" | ") || "None";
  const models = ["gemini-3.8-flash", "gemini-2.5-flash"];
  const attemptsPerModel = 2;

  const prompt = `Create a 5-slide Instagram carousel on a fresh, engaging topic that is NOT in this already-used list: ${recentTopics}.
Provide:
1. "topic": short title of the topic
2. "caption": social media caption with 5-8 relevant hashtags at the end
3. "slides": an array of EXACTLY 5 objects, each with:
   - "overlay_text": punchy overlay text (max ~18 words) to place on that slide
   - "photo_query": a clean 2-3 word stock photo search query (no text or watermarks)`;

  const schemaConfig = {
    responseMimeType: "application/json",
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING },
        caption: { type: Type.STRING },
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
      required: ["topic", "caption", "slides"],
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
            abortSignal: AbortSignal.timeout(45000),
          },
        });

        return JSON.parse(response.text);
      } catch (err) {
        lastError = err;
        const status = err?.status || err?.code || "";
        const msg = err?.message || String(err);
        console.warn(
          `[${model}] attempt ${attempt}/${attemptsPerModel} failed (${status}): ${msg}`
        );

        // Wait a bit longer before retrying on 503 / transient errors
        const waitMs = 4000 * attempt + Math.floor(Math.random() * 1500);
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
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
    query
  )}&per_page=5&orientation=portrait`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Unsplash request failed (${res.status}) for query "${query}"`);
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
        Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
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

  // Cover-fit background photo into 1080x1350
  const img = await loadImage(photoBuffer);
  const scale = Math.max(WIDTH / img.width, HEIGHT / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const drawX = (WIDTH - drawW) / 2;
  const drawY = (HEIGHT - drawH) / 2;
  ctx.drawImage(img, drawX, drawY, drawW, drawH);

  // Dark gradient overlay so white text stays readable
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, "rgba(0, 0, 0, 0.35)");
  grad.addColorStop(0.5, "rgba(0, 0, 0, 0.55)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0.65)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Slide counter pill at top
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = "bold 28px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`SLIDE ${slideNum} / ${totalSlides}`, WIDTH / 2, 110);

  // Main overlay text centered
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 54px sans-serif";
  ctx.textAlign = "center";
  drawWrappedText(ctx, overlayText, WIDTH / 2, HEIGHT / 2, WIDTH - 140, 72);

  return canvas.toBuffer("image/png");
}

function getDriveClient() {
  const creds = JSON.parse(process.env.GDRIVE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
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

  const captionFile = path.join(localDir, "caption.txt");
  fs.writeFileSync(
    captionFile,
    `Topic: ${plan.topic}\n\n${plan.caption}\n\nPhoto Credits:\n${photoCredits.join(
      "\n"
    )}\n\nSlide Texts:\n${slides
      .map((s, idx) => `${idx + 1}. ${s.overlay_text}`)
      .join("\n")}\n`
  );
  uploadedFiles.push({ filePath: captionFile, mimeType: "text/plain" });

  const drive = getDriveClient();
  const subfolderId = await createDriveSubfolder(
    drive,
    process.env.GDRIVE_FOLDER_ID,
    `${dateTag} - ${plan.topic.slice(0, 40)}`
  );

  for (const item of uploadedFiles) {
    await uploadFileToDrive(drive, item.filePath, item.mimeType, subfolderId);
  }

  history.usedTopics.push(plan.topic);
  saveHistory(history);

  console.log(`Uploaded carousel for topic "${plan.topic}" to Google Drive folder ${subfolderId}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
