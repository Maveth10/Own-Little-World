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

// Pobieranie wektora zapytania
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
    const { messages = [], prompt = '', message = '' } = body;

    const lastUserMessage = prompt || message || (messages.length > 0 ? messages[messages.length - 1].content : '');

    if (!lastUserMessage) {
      return NextResponse.json({ error: "Brak pytania." }, { status: 400 });
    }

    let contextChunks = [];

    // 1. WYSZUKIWANIE WEKTOROWE W ai_memory
    const queryEmbedding = await getEmbedding(lastUserMessage);

    if (queryEmbedding) {
      try {
        const { data: vectorData } = await supabase.rpc('match_ai_memory', {
          query_embedding: queryEmbedding,
          match_threshold: 0.01,
          match_count: 8
        });

        if (vectorData && vectorData.length > 0) {
          contextChunks = vectorData;
        }
      } catch (e) {
        console.warn("Błąd match_ai_memory:", e.message);
      }
    }

    // 2. BEZPIECZNE WYSZUKIWANIE TEKSTOWE
    if (contextChunks.length === 0) {
      // Wyciąganie bezpiecznych symboli technicznych (np. 1A8, 3-21-52.0189)
      const cleanTerms = lastUserMessage
        .replace(/[^a-zA-Z0-9.-]/g, ' ')
        .split(' ')
        .filter(w => w.length >= 2);

      try {
        for (const term of cleanTerms) {
          const { data: searchResults } = await supabase
            .from('ai_memory')
            .select('*')
            .or(`title.ilike.%${term}%,content.ilike.%${term}%`)
            .limit(6);

          if (searchResults && searchResults.length > 0) {
            contextChunks.push(...searchResults);
          }
        }
      } catch (err) {
        console.warn("Błąd wyszukiwania słów kluczowych:", err.message);
      }

      // Fallback: Zawsze pobierz ostatnie wpisy z ai_memory w przypadku braku dopasowań
      if (contextChunks.length === 0) {
        const { data: recentData } = await supabase
          .from('ai_memory')
          .select('*')
          .order('id', { ascending: false })
          .limit(6);

        if (recentData) contextChunks = recentData;
      }
    }

    // Usuwanie ewentualnych powtórzeń w znalezionych rekordach
    const uniqueChunks = Array.from(new Set(contextChunks.map(c => c.id)))
      .map(id => contextChunks.find(c => c.id === id));

    // 3. PRZYGOTOWANIE TREŚCI DLA MODELU
    let contextText = "";
    const pdfLinks = new Set();

    uniqueChunks.forEach((chunk, idx) => {
      contextText += `\n--- DOKUMENTACJA ${idx + 1} (${chunk.title}) ---\n${chunk.content}\n`;
      if (chunk.image_url) {
        pdfLinks.add(chunk.image_url);
      }
    });

    if (pdfLinks.size > 0) {
      contextText += `\nPLIKI SCHEMATÓW DO TEJ DOKUMENTACJI:\n` + Array.from(pdfLinks).map(url => `- ${url}`).join('\n') + `\n`;
    }

    // 4. SYSTEM PROMPT
    const systemPrompt = `Jesteś Głównym Inżynierem Serwisu Axon AI. 
Odpowiadaj precyzyjnie, zwięźle i bardzo technicznie na podstawie BAZY WIEDZY.
Jeżeli w BAZIE WIEDZY znajduje się link URL do pliku PDF, ZAWSZE dołącz go w odpowiedzi w formacie Markdown: [Pobierz/Otwórz Schemat PDF](URL).

BAZA WIEDZY Z TABELI ai_memory:
${contextText || "Brak szczegółów w bazie."}`;

    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.filter(m => m.role !== 'system')
    ];

    if (messages.length === 0 && lastUserMessage) {
      formattedMessages.push({ role: 'user', content: lastUserMessage });
    }

    // 5. WYWOŁANIE MODELU GROQ
    const chatCompletion = await groq.chat.completions.create({
      messages: formattedMessages,
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
    });

    const replyText = chatCompletion.choices[0]?.message?.content || "Brak odpowiedzi od AI.";

    // Uniwersalna struktura danych JSON pasująca do każdego interfejsu
    return NextResponse.json({
      role: 'assistant',
      content: replyText,
      reply: replyText,
      message: replyText,
      text: replyText
    });

  } catch (error) {
    console.error("Błąd w trakcie czatu:", error);
    return NextResponse.json({ 
      error: error.message,
      content: `Błąd serwera: ${error.message}`,
      reply: `Błąd serwera: ${error.message}`
    }, { status: 500 });
  }
}