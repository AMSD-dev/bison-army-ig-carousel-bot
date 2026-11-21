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

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Create a 5-slide Instagram carousel on a fresh, engaging topic that is NOT in this already-used list: ${recentTopics}.
Provide:
1. "topic": short title of the topic
2. "caption": social media caption with 5-8 relevant hashtags at the end
3. "slides": an array of EXACTLY 5 objects, each with:
   - "overlay_text": punchy overlay text (max ~18 words) to place on that slide
   - "photo_query": a clean 2-3 word stock photo search query (no text or watermarks)`,
    config: {
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
    },
  });

  return JSON.parse(response.text);
}

async function fetchPexelsImageBuffer(query, index) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=5&orientation=portrait`;
  const res = await fetch(url, {
    headers: { Authorization: process.env.PEXELS_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`Pexels request failed (${res.status}) for query "${query}"`);
  }

  const data = await res.json();
  const photo = data.photos?.[index % (data.photos?.length || 1)] || data.photos?.[0];
  if (!photo?.src?.large2x) {
    throw new Error(`No Pexels photo found for "${query}"`);
  }

  const imgRes = await fetch(photo.src.large2x);
  return Buffer.from(await imgRes.arrayBuffer());
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

  for (let i = 0; i < slides.length; i++) {
    const slideNum = i + 1;
    const photoBuf = await fetchPexelsImageBuffer(slides[i].photo_query, i);
    const pngBuf = await renderSlidePng(photoBuf, slides[i].overlay_text, slideNum, slides.length);
    const outFile = path.join(localDir, `slide-${slideNum}.png`);
    fs.writeFileSync(outFile, pngBuf);
    uploadedFiles.push({ filePath: outFile, mimeType: "image/png" });
  }

  const captionFile = path.join(localDir, "caption.txt");
  fs.writeFileSync(
    captionFile,
    `Topic: ${plan.topic}\n\n${plan.caption}\n\nSlide Texts:\n${slides
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
