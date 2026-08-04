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
        responseMimeType: 'text/plain'
      }
    });

    const prompt = `You are a professional resume writer and LaTeX formatting expert.
You will be given the LaTeX code of a resume and a target Job Description (JD).
Your task is to tailor the resume specifically for this JD to maximize the ATS matching score.

Original Resume LaTeX:
------------------------------------------
${originalLatex}
------------------------------------------

Target Job Description:
------------------------------------------
${jd}
------------------------------------------

Guidelines:
1. Tailor the "Career Objective", "Key Skills", and "Professional Experience" bullet points to emphasize relevant technologies, metrics, and achievements mentioned in the JD.
2. Keep the candidate's actual projects (AFL Global, Olivet Migration, Serverless Finance Manager) and experience at Veltris, but align the descriptions and keywords.
3. Keep the single-page layout optimizations. Do not expand the content so much that it overflows to a second page.
4. Do NOT modify the candidate's contact details, name, or education details.
5. WARNING: You MUST properly escape all special LaTeX characters in your generated text (e.g., use \\& instead of &, \\% instead of %, \\$ instead of $). Failure to do so will crash the compiler.
6. Keep the "AI Tools" section intact. Add to it if required by the JD, but do NOT remove it or its existing contents.
7. Your response MUST contain ONLY the raw updated LaTeX code. Do NOT wrap it in markdown code blocks (such as \`\`\`latex or \`\`\`). Output exactly the LaTeX code beginning with \\documentclass and ending with \\end{document}.`;

    const result = await model.generateContent(prompt);
    let tailoredLatex = result.response.text().trim();

    // Clean up potential markdown formatting if the model ignored the instructions
    if (tailoredLatex.startsWith("```")) {
      tailoredLatex = tailoredLatex.replace(/^```[a-zA-Z]*\n/, "").replace(/\n```$/, "");
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
