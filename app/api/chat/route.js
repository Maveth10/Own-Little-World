import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch(
      "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "x-wait-for-model": "true" }, method: "POST", body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }) }
    );
    if (!response.ok) return null;
    const result = await response.json();
    return (Array.isArray(result) && Array.isArray(result[0])) ? result[0] : (Array.isArray(result) ? result : null);
  } catch { return null; }
}

export async function POST(req) {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabase = getSupabase();

    const formData = await req.formData();
    const prompt = formData.get('prompt') || '';
    const image = formData.get('image');
    
    const historyStr = formData.get('history') || '[]';
    let history = [];
    try { history = JSON.parse(historyStr); } catch { history = []; }

    const queryVector = await getEmbedding(prompt);
    let docs = [];
    if (queryVector) {
      const { data, error } = await supabase.rpc('match_memory', { query_embedding: queryVector, match_threshold: 0.1, match_count: 2 });
      if (!error && data) docs = data;
    }

    let contextText = docs.length > 0 ? "\n\n--- DOPASOWANA DOKUMENTACJA ---\n" + docs.map((d, i) => `\n[DOKUMENT ${i + 1}: ${d.title}]\nTreść: ${d.content}\n${d.image_url ? `LINK: ${d.image_url}` : ''}`).join('\n') : "";
    const systemInstruction = `Jesteś głównym inżynierem serwisu Axon AI. Znasz się na stacjach ładowania EV, schematach elektrycznych i diagnozie usterek. Opieraj się na dokumentacji i historii rozmowy.`;

    let responseText = "";
    const hasImage = image && typeof image === 'object' && image.size > 0;

    let messages = [
      { role: 'system', content: systemInstruction + contextText },
      ...history
    ];

    if (hasImage) {
      // ---------------------------------------------------------
      // ETAP 1: "OCZY" - Wczytanie schematu przez Nvidia Vision
      // ---------------------------------------------------------
      const buffer = Buffer.from(await image.arrayBuffer());
      const base64Image = buffer.toString("base64");
      const mimeType = image.type || "image/jpeg";
      const orApiKey = process.env.OPENROUTER_API_KEY;

      const visionPrompt = "Jesteś asystentem wizyjnym. Twoim JEDYNYM zadaniem jest przeanalizować ten obraz/schemat i opisać go w najdrobniejszych szczegółach dla inżyniera. Wypisz wszystkie widoczne elementy, teksty, oznaczenia pinów, przekaźników, połączenia kablowe i stany diod. Nie odpowiadaj na pytania, tylko opisz obraz.";

      const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${orApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000", 
          "X-Title": "Axon AI" 
        },
        body: JSON.stringify({
          model: "nvidia/nemotron-nano-12b-v2-vl:free", // Używamy Twojego modelu od Nvidii
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: visionPrompt },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
              ]
            }
          ]
        })
      });

      let visionDescription = "Model wizyjny nie był w stanie odczytać obrazu.";
      if (orResponse.ok) {
        const orData = await orResponse.json();
        visionDescription = orData.choices[0]?.message?.content || visionDescription;
      }

      // ---------------------------------------------------------
      // ETAP 2: "MÓZG" - Groq 70B diagnozuje problem
      // ---------------------------------------------------------
      const groqPrompt = `Użytkownik wysłał zdjęcie/schemat i zadał pytanie: "${prompt}".\n\nOpis obrazu wygenerowany przez model wizyjny:\n"${visionDescription}"\n\nNa podstawie powyższego opisu, dokumentacji i swojej szerokiej wiedzy o stacjach ładowania EV, rozwiąż problem użytkownika.`;
      
      messages.push({ role: 'user', content: groqPrompt });

      const chatCompletion = await groq.chat.completions.create({
        messages: messages,
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
      });
      responseText = chatCompletion.choices[0]?.message?.content || "Brak odpowiedzi od Groq.";

    } else {
      // ---------------------------------------------------------
      // TYLKO TEKST - Groq działa błyskawicznie sam
      // ---------------------------------------------------------
      messages.push({ role: 'user', content: prompt });
      
      const chatCompletion = await groq.chat.completions.create({
        messages: messages,
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
      });
      responseText = chatCompletion.choices[0]?.message?.content || "Brak odpowiedzi od Groq.";
    }

    return NextResponse.json({ success: true, text: responseText });
  } catch (error) {
    console.error("Błąd API:", error);
    return NextResponse.json({ success: false, error: error.message || 'Błąd serwera' }, { status: 500 });
  }
}