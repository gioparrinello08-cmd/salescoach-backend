const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config({ path: '../.env' });

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages,
    });
    const text = response.content[0].text
      .replace(/\*\*/g, '').replace(/\*/g, '').replace(/#/g, '')
      .replace(/---/g, '').replace(/Prossima domanda/gi, '')
      .replace(/Feedback sulla risposta precedente/gi, '')
      .replace(/\n{3,}/g, '\n\n').trim();
    res.json({ content: text });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-questions', async (req, res) => {
  try {
    const { role, interviewType, company, cvText } = req.body;
    const cvContext = cvText ? `\n\nCV del candidato:\n${cvText.slice(0, 2000)}` : '';
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `Sei un esperto recruiter di ${company || 'una azienda tech'} in ambito sales e fintech. Genera esattamente 5 domande di colloquio in italiano per un candidato che punta al ruolo di "${role}". Tipo: ${interviewType}.${cvContext ? ' Personalizza le domande in base al CV del candidato.' : ''} Rispondi SOLO con un array JSON valido senza testo aggiuntivo, senza backtick, senza markdown: ["domanda1","domanda2","domanda3","domanda4","domanda5"]${cvContext}`,
      messages: [{ role: 'user', content: 'Genera le domande.' }],
    });
    let text = response.content[0].text.trim();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1) text = text.substring(start, end + 1);
    const questions = JSON.parse(text);
    res.json({ questions });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate-report', async (req, res) => {
  try {
    const { messages, name, role } = req.body;
    const conversazione = messages
      .map(m => `${m.role === 'user' ? 'Candidato' : 'Intervistatore'}: ${m.content}`)
      .join('\n');
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: `Sei un coach esperto in sales e fintech. Rispondi SOLO con JSON puro, nessun testo aggiuntivo, nessun backtick, nessun markdown. Solo il JSON che inizia con { e finisce con }.
Formato obbligatorio:
{"voto":8,"chiarezza":7,"struttura":8,"confidenza":9,"punti_forza":["punto1","punto2","punto3"],"miglioramenti":["punto1","punto2","punto3"],"consiglio":"Una frase di consiglio pratico."}
Tutti i valori numerici sono interi da 1 a 10.`,
      messages: [{
        role: 'user',
        content: `Analizza questo colloquio e restituisci SOLO il JSON:\n\n${conversazione}\n\nIl candidato si chiama ${name} e punta al ruolo di ${role}.`
      }],
    });
    let text = response.content[0].text.trim();
    text = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('JSON non trovato: ' + text);
    text = text.substring(start, end + 1);
    const report = JSON.parse(text);
    res.json(report);
  } catch (error) {
    console.error('REPORT ERROR:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => console.log('Backend running on port 3001'));