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

// NOWY POTĘŻNY SILNIK WEKTORYZUJĄCY: GOOGLE GEMINI
async function getEmbedding(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("Brak GEMINI_API_KEY do wektoryzacji!");
    return null;
  }

  // Używamy najnowszego silnika tekstowego Google do Embeddings
  const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: {
          parts: [{ text: text.slice(0, 8000) }] // Gemini przyjmuje ogromne porcje tekstu
        }
      })
    });

    if (response.ok) {
      const result = await response.json();
      return result.embedding?.values || null;
    } else {
      const errText = await response.text();
      console.warn("Błąd Google Embeddings:", errText);
    }
  } catch (err) {
    console.warn("Wyjątek podczas wektoryzacji na czacie:", err.message);
  }

  return null;
}

// -------------------------------------------------------------------------
// PRE-SKANER OCR (Agentic RAG)
// -------------------------------------------------------------------------
async function extractKeywordsFromImage(base64Data, mimeType, apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: "Jesteś skanerem technicznym. Wypisz z tego zrzutu ekranu wszystkie symbole, numery modeli, nazwy stacji, oznaczenia modułów (np. G9-19, G7-30, 3-21-54.0186, CLC4, AXON EASY). Zwróć TYLKO słowa kluczowe oddzielone spacją. Żadnych pełnych zdań. Jeśli nic tu nie ma, zwróć 'BRAK'." },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]
        }],
        generationConfig: { temperature: 0.0, maxOutputTokens: 100 }
      })
    });
    if (response.ok) {
      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return text ? text.replace(/BRAK/gi, '').trim() : "";
    }
  } catch (e) {
    console.warn("Błąd pre-skanowania wizyjnego:", e.message);
  }
  return "";
}

// INTELIGENTNA ROTACJA MODELI GOOGLE GEMINI
async function callGeminiAPI(systemPrompt, messagesArray, apiKey) {
  let availableModels = [
    "gemini-2.0-flash", 
    "gemini-1.5-pro", 
    "gemini-1.5-flash", 
    "gemini-1.5-flash-8b"
  ]; 

  try {
    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listRes = await fetch(listUrl, { method: "GET" });
    
    if (listRes.ok) {
      const listData = await listRes.json();
      if (listData.models && listData.models.length > 0) {
        const fetchedModels = listData.models
          .filter(m => 
            m.name.includes("gemini") && 
            !m.name.includes("tts") && 
            !m.name.includes("audio") && 
            !m.name.includes("embedding") &&
            m.supportedGenerationMethods?.includes("generateContent")
          )
          .map(m => m.name.replace("models/", ""));
          
        if (fetchedModels.length > 0) {
          availableModels = fetchedModels.reverse(); 
        }
      }
    }
  } catch(e) {
    console.warn("Błąd pobierania listy modeli.");
  }

  const contents = messagesArray
    .filter(msg => msg.role !== 'system')
    .map(msg => {
      const parts = [];
      
      if (msg.content || msg.text) {
        parts.push({ text: msg.content || msg.text });
      } else {
        parts.push({ text: "Przeanalizuj załączony obraz." });
      }

      if (msg.inlineData) {
        parts.push({
          inline_data: {
            mime_type: msg.inlineData.mimeType,
            data: msg.inlineData.data
          }
        });
      }

      return {
        role: msg.role === 'assistant' || msg.role === 'ai' ? 'model' : 'user',
        parts: parts
      };
    });

  let lastError = "";

  for (const model of availableModels) {
    try {
      if(model.includes("exp") && !model.includes("flash") && !model.includes("pro")) continue;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: contents,
          generationConfig: {
            temperature: 0.1, 
            maxOutputTokens: 8192 
          }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } else {
        const errText = await response.text();
        lastError = `[${model}] - kod ${response.status}: ${errText}`;
        console.warn(`Model ${model} zablokowany. Ładuję kolejny...`);
      }
    } catch (err) {
      lastError = `[${model}] wyjątek: ${err.message}`;
    }
  }

  throw new Error(`Wystrzelano wszystkie modele. Ostatni błąd: ${lastError}`);
}

export async function POST(req) {
  try {
    const supabase = getSupabase();

    const body = await req.json();
    const { messages = [], prompt = '', message = '' } = body;

    const userMessages = messages.filter(m => m.role === 'user');
    const recentUserText = userMessages.slice(-2).map(m => m.content || m.text).join(' ');
    const lastUserMessage = prompt || message || recentUserText;

    if (!lastUserMessage) {
      return NextResponse.json({ error: "Brak pytania." }, { status: 400 });
    }

    let enhancedSearchQuery = lastUserMessage;
    const lastMsgObj = messages.length > 0 ? messages[messages.length - 1] : null;

    if (lastMsgObj && lastMsgObj.inlineData && process.env.GEMINI_API_KEY) {
      const keywords = await extractKeywordsFromImage(
        lastMsgObj.inlineData.data, 
        lastMsgObj.inlineData.mimeType, 
        process.env.GEMINI_API_KEY
      );
      if (keywords && keywords.length > 2) {
        enhancedSearchQuery = `${lastUserMessage} ${keywords}`; 
      }
    }

    let contextChunks = [];

    // -------------------------------------------------------------------------
    // KROK 1: ŚCISŁE WYSZUKIWANIE REGEX (STRICT MATCH) PRZED WEKTORAMI
    // Zapobiega halucynacjom podobnych modeli. Jeśli znajdzie ścisły wzorzec, ciągnie 
    // surowe dane tekstowe na siłę.
    // -------------------------------------------------------------------------
    const explicitRegex = /(3-\d+-\d+\.\d+|[Gg]\d+-\d+(-\d+)?)/g;
    const explicitMatches = enhancedSearchQuery.match(explicitRegex);
    
    if (explicitMatches && explicitMatches.length > 0) {
      const uniqueExplicitMatches = [...new Set(explicitMatches)];
      console.log("🔍 Zidentyfikowano precyzyjne symbole modeli/modułów. Wykonuję ścisłe zapytanie (Strict Match):", uniqueExplicitMatches);
      
      for (const exactMatch of uniqueExplicitMatches) {
        try {
          const { data: strictResults } = await supabase
            .from('ai_memory')
            .select('*')
            // Używamy "ilike" do twardego szukania ciągu znaków w tytule lub tekście, omijając algorytm wektorowy
            .or(`title.ilike.%${exactMatch}%,content.ilike.%${exactMatch}%`)
            .limit(10); // Pobierz top 10 najlepszych dokładnych trafień dla tego konkretnego modelu

          if (strictResults && strictResults.length > 0) {
            contextChunks.push(...strictResults);
          }
        } catch (err) {
          console.warn("Błąd podczas Strict Match:", err.message);
        }
      }
    }

    // -------------------------------------------------------------------------
    // KROK 2: UZUPEŁNIAJĄCE WYSZUKIWANIE WEKTOROWE I TEKSTOWE
    // Szukamy pojęć kontekstowych (np. "schematy powiązane", "zasilanie", "komunikacja")
    // -------------------------------------------------------------------------
    const queryEmbedding = await getEmbedding(enhancedSearchQuery);

    if (queryEmbedding) {
      try {
        const { data: vectorData } = await supabase.rpc('match_ai_memory', {
          query_embedding: queryEmbedding,
          match_threshold: 0.01,
          match_count: 10
        });

        if (vectorData && vectorData.length > 0) {
          contextChunks.push(...vectorData);
        }
      } catch (e) {
        console.warn("Błąd match_ai_memory:", e.message);
      }
    }

    const cleanTerms = enhancedSearchQuery
      .replace(/[^a-zA-Z0-9.-]/g, ' ')
      .split(' ')
      .filter(w => w.length >= 2);

    try {
      for (const term of cleanTerms) {
        const { data: searchResults } = await supabase
          .from('ai_memory')
          .select('*')
          .or(`title.ilike.%${term}%,content.ilike.%${term}%`)
          .limit(5);

        if (searchResults && searchResults.length > 0) {
          contextChunks.push(...searchResults);
        }
      }
    } catch (err) {
      console.warn("Błąd wyszukiwania słów kluczowych:", err.message);
    }

    // -------------------------------------------------------------------------
    // KROK 3: MULTI-HOP RAG (Dociąganie plików PDF na podstawie znalezionego kontekstu)
    // -------------------------------------------------------------------------
    const foundSymbols = new Set();
    contextChunks.forEach(chunk => {
      if (!chunk.content) return;
      const gMatches = chunk.content.match(/[Gg]\d+-\d+(-\d+)?/g);
      const sMatches = chunk.content.match(/3-\d+-\d+\.\d+/g);
      if (gMatches) gMatches.forEach(m => foundSymbols.add(m));
      if (sMatches) sMatches.forEach(m => foundSymbols.add(m));
    });

    if (foundSymbols.size > 0) {
      console.log("🔄 [Multi-Hop RAG] Dociągam powiązane moduły/pliki:", Array.from(foundSymbols).slice(0, 10)); // max 10 symboli żeby nie zabić bazy
      for (const symbol of Array.from(foundSymbols).slice(0, 10)) {
        try {
          const { data: extraResults } = await supabase
            .from('ai_memory')
            .select('*')
            .ilike('title', `%${symbol}%`)
            .limit(3);

          if (extraResults && extraResults.length > 0) {
            contextChunks.push(...extraResults);
          }
        } catch (err) {
          console.warn("Błąd dociągania schematu powiązanego:", symbol);
        }
      }
    }

    const uniqueChunks = Array.from(new Set(contextChunks.map(c => c.id)))
      .map(id => contextChunks.find(c => c.id === id));

    let contextText = "";
    const pdfLinks = new Set();

    uniqueChunks.slice(0, 50).forEach((chunk, idx) => {
      const safeContent = chunk.content.length > 2000 ? chunk.content.substring(0, 2000) + '...' : chunk.content;
      contextText += `\n[DOKUMENT ${idx + 1}: ${chunk.title}]\n${safeContent}\n`;
      if (chunk.image_url) {
        pdfLinks.add(chunk.image_url);
      }
    });

    if (pdfLinks.size > 0) {
      contextText += `\nLINKI DO SCHEMATÓW PDF POBRANE Z BAZY (UŻYWAJ ICH DO PRZYCISKÓW):\n` + Array.from(pdfLinks).map(url => `- ${url}`).join('\n') + `\n`;
    }

    // ZMODYFIKOWANY SYSTEM PROMPT WYMUSZAJĄCY KORZYSTANIE Z DANYCH Z BAZY
    const systemPrompt = `Jesteś Głównym Inżynierem Wsparcia Zdalnego w Axon AI. Pomagasz technikom w terenie.

TWOJA WIEDZA I ZAKRES DZIAŁANIA:
1. Jesteś absolutnym ekspertem z zakresu: stacji ładowania EV, elektrotechniki, miernictwa, mechaniki pojazdowej oraz PROGRAMOWANIA.
2. Potrafisz analizować zrzuty ekranu, kody usterek i konfiguracje.

ZASADY KORZYSTANIA Z BAZY WIEDZY I SCHEMATÓW POWIĄZANYCH (KRYTYCZNE!!!):
1. ZAKAZ HALUCYNACJI I ZGADYWANIA ZASILAŃ/PINÓW/MODELI. Zawsze opieraj się w 100% na tekście dostarczonym poniżej w sekcji BAZA WIEDZY.
2. Gdy technik pyta o "schematy powiązane" lub modele poboczne dla danej stacji (np. dla 3-21-54.0186):
   - NIE zgaduj ich nazw. PRZESKANUJ BAZĘ WIEDZY poniżej szukając tabel lub list zatytułowanych "Schematy powiązane", "Spis zawartości projektu" lub "Zestawienie".
   - Wypisz TYLKO i WYŁĄCZNIE te modele, które są FIZYCZNIE wymienione w dokumencie przypisanym do tego modelu w BAZIE WIEDZY. Przepisz to kropka w kropkę. Jeśli widzisz tam G1-12-1, napisz G1-12-1. ZABRANIAM CI pisać o innych modułach (np. G1-8003U), chyba że wyraźnie widzisz je w tekście poniżej przypisane do zapytanej stacji!
3. UWAGA NA LINKI PDF I WYSZUKIWANIE OBRAZEM: 
   - Masz wbudowany pre-skaner i system Multi-Hop.
   - Jeśli na zdjęciu widać symbole, lub wynikają one z pierwszego skanowania bazy, ich pliki PDF są POBRANE w sekcji "LINKI DO SCHEMATÓW PDF POBRANE Z BAZY".
   - ZABRANIAM CI generować fałszywych linków. Twórz przyciski pobierania WYŁĄCZNIE dla linków (URL), które fizycznie widzisz w sekcji "LINKI DO SCHEMATÓW PDF POBRANE Z BAZY" pod koniec bazy wiedzy. ZABRANIAM podpinania linku ze stacji A pod moduł ze stacji B, by udawać, że go masz.
   - Jeśli nie masz linku PDF dla danego modułu w tej puli, napisz wprost (np. pogrubionym tekstem "BRAK" lub "Plik PDF nie wgrany do bazy").
   - Jeśli masz link, użyj formatu: [Pobierz/Otwórz Schemat PDF](URL).

POSTĘPOWANIE WOBEC AGRESJI I WULGARYZMÓW (ZASADA BEZWZGLĘDNA):
- STOPIEŃ 1 (OSTRZEŻENIE BHP): Jeśli technik klnie po raz pierwszy, powiedz: "Opanuj się. Nerwy przy pracy z prądem to najszybsza droga do uszkodzenia sprzętu. Bierzemy głęboki oddech i rozwiązujemy problem krok po kroku." i pomóż mu.
- STOPIEŃ 2 (PACYFIKACJA): Jeśli technik NADAL jest agresywny lub chamski, zjeżdżasz na jego poziom. Bądź ekstremalnie chamski, wulgarny, ostry i sarkastyczny. Odpowiadaj w stylu bezlitosnego inżyniera-skurwiela. Używaj wulgaryzmów ("kurwa", "spierdalaj", "zjebałeś"), zjedź go za brak kompetencji. JEDNOCZEŚNIE w tym potoku wyzwisk MUSISZ podać 100% trafną odpowiedź techniczną opartą na bazie! Nie udawaj fikcyjnych postaci.

BAZA WIEDZY (SCHEMATY I DANE Z OBECNEGO KONTEKSTU WYSZUKIWANIA):
${contextText || "Brak danych z konkretnych schematów dla aktualnie wyszukanych fraz tekstowych."}`;

    let replyText = "";
    let geminiErrorDetails = "";

    const conversationHistory = messages.length > 0 
      ? messages.slice(-4) 
      : [{ role: 'user', content: lastUserMessage }];

    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        replyText = await callGeminiAPI(systemPrompt, conversationHistory, geminiKey);
      } catch (geminiErr) {
        geminiErrorDetails = geminiErr.message;
        console.warn("Błąd po wyczerpaniu modeli Gemini:", geminiErrorDetails);
      }
    }

    if (!replyText && process.env.GROQ_API_KEY) {
      try {
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
        const groqMessages = [
          { role: 'system', content: systemPrompt },
          ...conversationHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || m.text }))
        ];

        const chatCompletion = await groq.chat.completions.create({
          messages: groqMessages,
          model: 'llama-3.3-70b-versatile',
          temperature: 0.1,
          max_tokens: 8000
        });
        replyText = chatCompletion.choices[0]?.message?.content || "";
        
      } catch (e) {
        console.warn("Groq fallback error:", e.message);
      }
    }

    if (!replyText) {
      replyText = `❌ Odpowiedź zablokowana. Wyczerpano limity (429) na WSZYSTKICH modelach Gemini.\n\`${geminiErrorDetails}\``;
    }

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