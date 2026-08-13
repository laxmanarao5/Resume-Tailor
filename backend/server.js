const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { compile } = require('node-latex-compiler');
const AdmZip = require('adm-zip');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Path to the primary Resume.tex file (now bundled inside /backend for deployment)
const RESUME_PATH = path.join(__dirname, 'Resume.tex');

// Helper function to check if pdflatex is installed locally
function isPdflatexAvailable() {
  return new Promise((resolve) => {
    const checkCmd = process.platform === 'win32' ? 'where pdflatex' : 'which pdflatex';
    exec(checkCmd, (error) => {
      resolve(!error);
    });
  });
}

// Compile LaTeX locally
function compileLocally(texPath, outputDir) {
  return new Promise((resolve, reject) => {
    // Run twice to resolve references/cross-links if any
    const cmd = `pdflatex -interaction=nonstopmode -output-directory="${outputDir}" "${texPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("Local pdflatex compile error stdout:", stdout);
        console.error("Local pdflatex compile error stderr:", stderr);
        return reject(error);
      }
      resolve();
    });
  });
}

// Compile LaTeX via node-latex-compiler
async function compileViaNodeLatex(latexCode) {
  console.log("Compiling via node-latex-compiler... (This might take a few minutes the first time as it downloads the LaTeX engine and packages!)");
  const result = await compile({
    tex: latexCode,
    returnBuffer: true,
    onStdout: (msg) => console.log("[Tectonic]:", msg.trim()),
    onStderr: (msg) => console.warn("[Tectonic Warning]:", msg.trim())
  });
  
  if (result.status === 'success') {
    return result.pdfBuffer;
  } else {
    throw new Error("Compilation failed: " + result.stderr);
  }
}

// Fetch template from Overleaf
async function fetchOverleafTemplate() {
  const readLink = process.env.OVERLEAF_READ_LINK;
  if (!readLink) return null;
  
  try {
    console.log("Fetching template from Overleaf...");
    // Extract project ID from the read-only link (e.g., https://www.overleaf.com/read/abcdefghijk)
    const projectId = readLink.split('/read/')[1]?.split('/')[0];
    if (!projectId) throw new Error("Invalid Overleaf read link");
    
    const zipUrl = `https://www.overleaf.com/project/${projectId}/download/zip`;
    const response = await axios.get(zipUrl, { responseType: 'arraybuffer' });
    
    const zip = new AdmZip(response.data);
    const zipEntries = zip.getEntries();
    
    // Find main.tex
    const mainEntry = zipEntries.find(entry => entry.entryName === 'main.tex');
    if (!mainEntry) throw new Error("main.tex not found in Overleaf zip");
    
    return mainEntry.getData().toString('utf8');
  } catch (err) {
    console.warn("Failed to fetch from Overleaf, falling back to local Resume.tex:", err.message);
    return null;
  }
}

app.post('/api/tailor', async (req, res) => {
  const { jd } = req.body;
  if (!jd || jd.trim() === '') {
    return res.status(400).json({ error: "Job description is required" });
  }

  // 1. Read Resume template (from Overleaf or local)
  let originalLatex = await fetchOverleafTemplate();
  if (!originalLatex) {
    if (!fs.existsSync(RESUME_PATH)) {
      return res.status(500).json({ error: "Source Resume.tex not found locally and Overleaf link failed or not set." });
    }
    originalLatex = fs.readFileSync(RESUME_PATH, 'utf8');
  }

  // 2. Call Gemini to tailor LaTeX
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.startsWith("YOUR_")) {
    return res.status(500).json({ error: "Gemini API key is not configured in backend/.env" });
  }

  try {
    console.log("Calling Gemini API to tailor resume...");
    const ai = new GoogleGenerativeAI(apiKey);
    
    // Using gemini-3.1-flash-lite as pro does not have free tier quota
    const model = ai.getGenerativeModel({
      model: 'gemini-3.1-flash-lite',
      generationConfig: {
        responseMimeType: 'text/plain',
        temperature: 0.35,
        maxOutputTokens: 4096
      }
    });

    const prompt = `You are an expert technical resume writer, ATS (Applicant Tracking System) optimization specialist, and LaTeX formatting expert who has helped hundreds of software engineers get more interview call-backs.

You will be given the candidate's real LaTeX resume and a target Job Description (JD). Your job is to rewrite the resume LaTeX so it scores as high as possible with ATS keyword-matching engines AND reads as a strong, credible fit to a human hiring manager in the first 30 seconds — WITHOUT fabricating anything.

Original Resume LaTeX:
------------------------------------------
${originalLatex}
------------------------------------------

Target Job Description:
------------------------------------------
${jd}
------------------------------------------

STEP 1 — Silently analyze the JD (do not print this analysis, just use it):
- Identify the exact job title, seniority level, and the 15-20 most important required/preferred skills, tools, frameworks, and keywords.
- For each keyword, note both the spelled-out form and its acronym if applicable (e.g. "Continuous Integration/Continuous Deployment (CI/CD)"), since ATS engines often do literal string matching and you want to cover both forms.
- Note the JD's own preferred terminology (e.g. "microservices" vs "service-oriented architecture") so you can mirror its exact wording wherever the candidate genuinely has that skill.
- Cross-reference against the candidate's original resume to find which of their real skills, tools, and quantified achievements are most relevant to this JD.

STEP 2 — Rewrite the resume applying these rules:
1. "Career Objective": rewrite as a punchy 2-3 line summary that mirrors the target job title/seniority and naturally weaves in the 4-6 most relevant JD keywords. It must read fluently to a human, never like a keyword dump.
2. "Key Skills": reorder items within each category so the ones matching the JD's top requirements come first. You may ADD a keyword only if it is already truthfully demonstrated elsewhere in the candidate's original resume (a project, experience bullet, or existing skill) — never invent a technology, certification, or tool the candidate has no real evidence of using.
3. "Professional Experience" and "Projects" bullets: rewrite the PHRASING (not the underlying facts) to foreground the JD's terminology, lead with strong action verbs, and surface the existing quantified metric (%, time saved, scale, records, latency, cost) in each bullet that already has one. Do NOT invent new numbers, scope, or claims that aren't already implied by the original bullet.
4. Never change real employer names, project names, job titles, or dates (e.g. Veltris, AFL Global, Olivet Migration, Serverless Finance Manager, AI Resume Tailor, RGUKT, and every date range) — only phrasing, emphasis, and ordering may change, never the underlying facts.
5. Preserve the single-page layout exactly as designed. If your edits would overflow to a second page, tighten wording rather than deleting information, and never touch the document's margins, font size, or packages.
6. Do NOT modify the candidate's name, contact/location line, or the Education section.
7. Keep the "AI & Tooling" skill line intact; you may append one JD-relevant AI/tooling entry to it only if the candidate's resume already shows real experience with it elsewhere, but never remove existing entries.
8. Avoid generic filler ("hardworking", "team player", "passionate") — every sentence must carry a concrete skill, tool, or metric.
9. WARNING: You MUST properly escape all special LaTeX characters in any text you write or modify (\\& for &, \\% for %, \\$ for $, \\# for #, \\_ for _). Unescaped characters will crash the compiler.

STEP 3 — Before returning your answer, silently self-check: every keyword you added is truthfully backed by the original resume; no employer/title/date/degree was altered; the LaTeX braces/environments are balanced and it compiles cleanly from \\documentclass to \\end{document}; the content still fits one page.

Your response MUST contain ONLY the raw, complete, updated LaTeX code — no commentary, no explanation, no markdown code fences (no \`\`\`latex or \`\`\`). Output must begin with \\documentclass and end with \\end{document}.`;

    const result = await model.generateContent(prompt);
    let tailoredLatex = result.response.text().trim();

    // Clean up potential markdown formatting if the model ignored the instructions
    if (tailoredLatex.startsWith("```")) {
      tailoredLatex = tailoredLatex.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
    }

    // Sanity-check the model's output before wasting a LaTeX compile attempt on garbage
    if (!tailoredLatex.startsWith("\\documentclass") || !tailoredLatex.includes("\\end{document}")) {
      return res.status(500).json({ error: "Gemini returned an invalid/incomplete LaTeX document. Please retry." });
    }

    const timestamp = Date.now();
    const TAILORED_TEX_PATH = path.join(os.tmpdir(), `Resume_${timestamp}.tex`);
    const TAILORED_PDF_PATH = path.join(os.tmpdir(), `Resume_${timestamp}.pdf`);

    // Save the tailored LaTeX
    fs.writeFileSync(TAILORED_TEX_PATH, tailoredLatex, 'utf8');
    console.log("Saved tailored LaTeX to:", TAILORED_TEX_PATH);

    // 3. Compile to PDF
    let pdfBuffer;
    const localAvailable = await isPdflatexAvailable();

    if (localAvailable) {
      console.log("Local pdflatex detected. Compiling locally...");
      try {
        const outputDir = path.dirname(TAILORED_TEX_PATH);
        await compileLocally(TAILORED_TEX_PATH, outputDir);
        pdfBuffer = fs.readFileSync(TAILORED_PDF_PATH);
      } catch (localErr) {
        console.error("Local compilation failed, falling back to node-latex-compiler...", localErr);
        pdfBuffer = await compileViaNodeLatex(tailoredLatex);
        fs.writeFileSync(TAILORED_PDF_PATH, pdfBuffer);
      }
    } else {
      console.log("Local pdflatex not found. Using node-latex-compiler...");
      pdfBuffer = await compileViaNodeLatex(tailoredLatex);
      // Write the compiled PDF to the workspace root for the user's convenience
      fs.writeFileSync(TAILORED_PDF_PATH, pdfBuffer);
    }

    console.log("PDF compiled successfully!");
    res.contentType("application/pdf");
    res.send(pdfBuffer);

  } catch (error) {
    console.error("Tailor process error:", error);
    res.status(500).json({ error: error.message || "Failed to tailor and compile resume" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
