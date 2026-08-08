import { Groq } from 'groq-sdk';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export const maxDuration = 60;

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w pliku .env");
  return createClient(url, key);
}

// Pobieranie wektora dla pytania użytkownika
async function getEmbedding(text) {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey) return null;

  const url = "https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "AxonAI-App/1.0",
        "x-wait-for-model": "true"
      },
      body: JSON.stringify({ inputs: text.slice(0, 500), options: { wait_for_model: true } }),
      signal: controller.signal,
      cache: "no-store"
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const result = await response.json();
      if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
      if (Array.isArray(result) && typeof result[0] === 'number') return result;
    }
  } catch (err) {
    console.warn("Hugging Face timeout na czacie:", err.message);
  }

  return null;
}

export async function POST(req) {
  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabase = getSupabase();

    const body = await req.json();
    const { messages = [], prompt = '' } = body;

    const lastUserMessage = prompt || (messages.length > 0 ? messages[messages.length - 1].content : '');

    if (!lastUserMessage) {
      return NextResponse.json({ error: "Brak pytania." }, { status: 400 });
    }

    let contextChunks = [];

    // 1. SZUKANIE WEKTOROWE W ai_memory
    const queryEmbedding = await getEmbedding(lastUserMessage);

    if (queryEmbedding) {
      try {
        const { data: vectorData } = await supabase.rpc('match_ai_memory', {
          query_embedding: queryEmbedding,
          match_threshold: 0.05,
          match_count: 6
        });

        if (vectorData && vectorData.length > 0) {
          contextChunks = vectorData;
        }
      } catch (e) {
        console.warn("Błąd match_ai_memory, przejście do wyszukiwania tekstowego:", e.message);
      }
    }

    // 2. SZUKANIE TEKSTOWE / SYMBOLI W ai_memory
    if (contextChunks.length === 0) {
      const keywords = lastUserMessage
        .replace(/[^a-zA-Z0-9.-]/g, ' ')
        .split(' ')
        .filter(w => w.length >= 2);

      let query = supabase.from('ai_memory').select('*').limit(8);

      if (keywords.length > 0) {
        const filterConditions = keywords.map(w => `title.ilike.%${w}%,content.ilike.%${w}%`).join(',');
        query = query.or(filterConditions);
      }

      const { data: textData } = await query;
      if (textData && textData.length > 0) {
        contextChunks = textData;
      } else {
        // Fallback: pobranie najnowszych wpisów z ai_memory
        const { data: recentData } = await supabase.from('ai_memory').select('*').order('id', { ascending: false }).limit(6);
        if (recentData) contextChunks = recentData;
      }
    }

    // 3. PRZYGOTOWANIE TREŚCI DLA AI
    let contextText = "";
    const pdfLinks = new Set();

    contextChunks.forEach((chunk, idx) => {
      contextText += `\n--- FRAGMENT DOKUMENTACJI ${idx + 1} (${chunk.title}) ---\n${chunk.content}\n`;
      if (chunk.image_url) {
        pdfLinks.add(chunk.image_url);
      }
    });

    if (pdfLinks.size > 0) {
      contextText += `\nPLIKI SCHEMATÓW DO TEJ DOKUMENTACJI:\n` + Array.from(pdfLinks).map(url => `- ${url}`).join('\n') + `\n`;
    }

    // 4. SYSTEM PROMPT
    const systemPrompt = `Jesteś Głównym Inżynierem Serwisu Axon AI. 
Odpowiadaj bardzo precyzyjnie i technicznie na podstawie podanej BAZY WIEDZY.
Jeżeli w BAZIE WIEDZY znajduje się link URL do pliku PDF ze schematem, ZAWSZE umieść go w odpowiedzi jako klikalny odnośnik w formacie Markdown: [Pobierz/Otwórz Schemat PDF](URL).

BAZA WIEDZY DOKUMENTACJI TECHNICZNEJ (Z TABELI ai_memory):
${contextText || "Brak pasujących informacji w bazie wiedzy."}`;

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system')
    ];

    if (messages.length === 0 && lastUserMessage) {
      formattedMessages.push({ role: 'user', content: lastUserMessage });
    }

    // 5. ZAPYTANIE DO GROQ (LLAMA 70B)
    const chatCompletion = await groq.chat.completions.create({
      messages: formattedMessages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
    });

    const reply = chatCompletion.choices[0]?.message?.content || "Brak odpowiedzi od AI.";

    return NextResponse.json({ role: 'assistant', content: reply });

  } catch (error) {
    console.error("Błąd w trakcie czatu:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}