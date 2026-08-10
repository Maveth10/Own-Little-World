'use client';

import { useState } from 'react';
import { Upload, Folder, FileText, RefreshCw, X, CheckCircle, Trash2 } from 'lucide-react';
import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Brak kluczy Supabase w środowisku.");
  return createClient(url, key);
}

export default function TeachAI() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [files, setFiles] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [status, setStatus] = useState('');
  const [stats, setStats] = useState({ current: 0, total: 0, success: 0, skipped: 0, failed: 0 });

  const handleHardReset = async () => {
    if (!window.confirm("🚨 UWAGA: To bezpowrotnie usunie WSZYSTKIE schematy z bazy wektorowej oraz fizyczne pliki PDF z Supabase. Jesteś pewien?")) return;

    setIsProcessing(true);
    setStatus('🗑️ Czyszczenie bazy wektorowej i usuwanie plików...');
    
    try {
      const res = await fetch('/api/reset', { method: 'POST' });
      const data = await res.json();
      
      if (res.ok && data.success) {
        setStatus(`✅ Sukces! ${data.message}`);
        setFiles([]);
        setTitle('');
        setContent('');
      } else {
        setStatus(`❌ Błąd: ${data.error}`);
      }
    } catch (err) {
      setStatus("❌ Błąd komunikacji z serwerem podczas czyszczenia.");
    } finally {
      setIsProcessing(false);
    }
  };

  const scanEntry = async (entry) => {
    if (entry.isFile) {
      return new Promise((resolve) => {
        entry.file((file) => resolve([file]));
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await new Promise((resolve) => {
        reader.readEntries((results) => resolve(results));
      });
      const nestedFiles = await Promise.all(entries.map((e) => scanEntry(e)));
      return nestedFiles.flat();
    }
    return [];
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);

    const items = e.dataTransfer.items;
    if (!items) return;

    setStatus('🔍 Skanowanie przeciągniętej zawartości...');
    let extractedFiles = [];

    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) {
        const scanned = await scanEntry(entry);
        extractedFiles.push(...scanned);
      } else if (items[i].kind === 'file') {
        extractedFiles.push(items[i].getAsFile());
      }
    }

    const validFiles = extractedFiles.filter(
      (f) => f && (f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.endsWith('.pdf'))
    );

    setFiles((prev) => [...prev, ...validFiles]);
    setStatus(`📁 Wykryto i dodano ${validFiles.length} prawidłowych plików.`);
  };

  const handleFileSelection = (e) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files).filter(
        (f) => f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.endsWith('.pdf')
      );
      setFiles((prev) => [...prev, ...selected]);
      setStatus(`📁 Wybrano ${selected.length} plików.`);
    }
  };

  const removeFile = (index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleBatchSave = async () => {
    if (files.length === 0 && !title && !content) {
      setStatus('❌ Wybierz pliki, folder lub wprowadź notatkę!');
      return;
    }

    setIsProcessing(true);
    const supabase = getSupabase();

    if (files.length === 0) {
      setStatus('⏳ Przetwarzanie notatki tekstowej...');
      try {
        const res = await fetch('/api/teach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'parse', title, content }), 
        });
        const parseData = await res.json();
        if (parseData.success && parseData.chunks) {
           const embedRes = await fetch('/api/teach', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ action: 'embed', chunks: parseData.chunks }),
           });
           const embedData = await embedRes.json();
           if (embedData.success) {
             setStatus(`✅ Sukces! Zapisano notatkę.`);
             setTitle(''); setContent('');
           } else {
             setStatus('❌ Błąd wektoryzacji: ' + (embedData.error || 'Nieznany błąd'));
           }
        }
      } catch (err) {
        setStatus('❌ Błąd wysyłania notatki.');
      }
      setIsProcessing(false);
      return;
    }

    setStatus('🔍 Pobieranie listy plików z bazy do sprawdzenia duplikatów...');
    let existingStorageFiles = [];
    try {
      const { data } = await supabase.storage.from('schematics').list('', { limit: 1000 });
      if (data) existingStorageFiles = data.map((f) => f.name.toLowerCase());
    } catch (err) {
      console.warn('Nie udało się pobrać listy do deduplikacji:', err);
    }

    let successCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    
    // TABLICA DO PRZECHOWYWANIA BŁĘDÓW!
    let detailedErrors = []; 

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '');
      const isDuplicate = existingStorageFiles.some((existing) => existing.endsWith(safeName.toLowerCase()));

      if (isDuplicate) {
        skippedCount++;
        setStats({ current: i + 1, total: files.length, success: successCount, skipped: skippedCount, failed: failedCount });
        setStatus(`⏭️ [${i + 1}/${files.length}] Pominięto duplikat: ${file.name}`);
        continue;
      }

      try {
        setStatus(`⏳ [${i + 1}/${files.length}] Krok 1/3: Wgrywanie pliku ${file.name} do Supabase...`);
        const fileName = `${Date.now()}_${safeName}`;
        const fileType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

        const { error: uploadError } = await supabase.storage.from('schematics').upload(fileName, file, { contentType: fileType, upsert: true });
        if (uploadError) throw new Error(uploadError.message);

        const fileUrl = supabase.storage.from('schematics').getPublicUrl(fileName).data.publicUrl;
        existingStorageFiles.push(fileName.toLowerCase());

        setStatus(`🔍 [${i + 1}/${files.length}] Krok 2/3: Odczytywanie i cięcie tekstu z PDF...`);
        const parseRes = await fetch('/api/teach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'parse', title: title ? `${title} (${file.name})` : file.name, content, fileUrl, fileName: file.name, fileType }),
        });

        const parseData = await parseRes.json();
        if (!parseData.success || !parseData.chunks) throw new Error(parseData.error || "Błąd parsowania PDF.");

        const allChunks = parseData.chunks;
        const batchSize = 50;
        let savedChunksCount = 0;

        for (let j = 0; j < allChunks.length; j += batchSize) {
          const chunkBatch = allChunks.slice(j, j + batchSize);
          let batchSuccess = false;
          let waitTime = 60; 

          while (!batchSuccess) {
            setStatus(`🧠 [${i + 1}/${files.length}] Krok 3/3: Wektoryzacja paczki ${j+1}-${Math.min(j+batchSize, allChunks.length)} / ${allChunks.length} z pliku ${file.name}...`);
            
            const embedRes = await fetch('/api/teach', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'embed', chunks: chunkBatch }),
            });

            if (embedRes.status === 429) {
              for (let s = waitTime; s > 0; s--) {
                setStatus(`⏸️ Limit API Google. Pauza: ${s} sek. (Partia ${j+1}-${Math.min(j+batchSize, allChunks.length)} / ${allChunks.length})`);
                await new Promise(r => setTimeout(r, 1000));
              }
              waitTime += 15; 
              continue; 
            }

            // ODCZYTUJEMY BŁĄD PROSTO Z SERWERA!
            const embedData = await embedRes.json();
            
            if (!embedRes.ok || !embedData.success) {
              throw new Error(embedData.error || `Błąd serwera: Kod ${embedRes.status}`);
            }

            batchSuccess = true;
            savedChunksCount += chunkBatch.length;
          }
          await new Promise(r => setTimeout(r, 1500));
        }

        successCount++;
        setStatus(`✅ [${i + 1}/${files.length}] Sukces! Wygenerowano aż ${savedChunksCount} ultra-precyzyjnych wektorów dla ${file.name}.`);
      } catch (err) {
        console.error(err);
        failedCount++;
        detailedErrors.push(`Plik ${file.name}: ${err.message}`); // Zapisujemy dokładny powód porażki
      }

      setStats({ current: i + 1, total: files.length, success: successCount, skipped: skippedCount, failed: failedCount });
      await new Promise((r) => setTimeout(r, 1500)); 
    }

    // WYŚWIETLAMY WSZYSTKIE BŁĘDY NA EKRANIE, ŻEBY ICH NIE ZATAJAĆ!
    if (detailedErrors.length > 0) {
      setStatus(`⚠️ Proces zakończony z błędami! Zapisano: ${successCount}, Błędy: ${failedCount}. Szczegóły:\n${detailedErrors.join('\n')}`);
    } else {
      setStatus(`🎉 Zakończono! Zapisano nowych plików: ${successCount}, Pominięto duplikatów: ${skippedCount}, Błędy: ${failedCount}`);
    }
    
    setIsProcessing(false);
    setFiles([]);
    setTitle('');
    setContent('');
  }

  return (
    <div className="p-8 max-w-3xl mx-auto font-sans">
      <div className="flex justify-between items-start mb-2">
        <h1 className="text-3xl font-bold">Panel Głównego Inżyniera</h1>
        
        <button
          onClick={handleHardReset}
          disabled={isProcessing}
          className="flex items-center gap-2 bg-red-50 text-red-600 hover:bg-red-600 hover:text-white border border-red-200 font-bold py-2 px-4 rounded-lg transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          title="Usuwa wszystkie rekordy i pliki z Supabase"
        >
          <Trash2 size={18} />
          Wyczyść całą bazę i pliki
        </button>
      </div>
      
      <p className="text-gray-600 mb-8">
        Upuść plik, grupę plików lub cały folder. AI przeanalizuje dokumentację i powiąże dane.
      </p>

      <div className="flex flex-col gap-5">
        <input
          type="text"
          placeholder="Domyślny tytuł / prefiks (opcjonalnie)"
          value={title}
          disabled={isProcessing}
          onChange={(e) => setTitle(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-yellow-400 outline-none"
        />

        <textarea
          placeholder="Uwagi serwisowe / notatka ogólna (opcjonalnie)..."
          value={content}
          disabled={isProcessing}
          onChange={(e) => setContent(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg h-24 focus:ring-2 focus:ring-yellow-400 outline-none"
        />

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-2xl p-8 flex flex-col items-center justify-center transition-all ${
            isDragging
              ? 'border-yellow-500 bg-yellow-50 scale-[1.01]'
              : 'border-gray-300 bg-gray-50 hover:bg-gray-100'
          }`}
        >
          <Upload className={`mb-3 transition-transform ${isDragging ? 'scale-125 text-yellow-600' : 'text-gray-400'}`} size={40} />
          
          <p className="text-lg font-bold text-gray-800 text-center">
            Przeciągnij i upuść tutaj dowolne pliki lub cały folder
          </p>
          <p className="text-xs text-gray-500 mt-1 mb-4 text-center">
            System automatycznie przeskanuje zawartość i wykryje pliki PDF oraz zdjęcia.
          </p>

          <div className="flex flex-wrap gap-3 justify-center">
            <label className="cursor-pointer bg-white border border-gray-300 hover:border-gray-400 text-gray-700 font-semibold px-4 py-2 rounded-lg shadow-sm text-sm flex items-center gap-2 transition-all">
              <FileText size={16} className="text-yellow-600" />
              Wybierz Plik(i)
              <input
                type="file"
                multiple
                accept="image/*,application/pdf"
                className="hidden"
                disabled={isProcessing}
                onChange={handleFileSelection}
              />
            </label>

            <label className="cursor-pointer bg-white border border-gray-300 hover:border-gray-400 text-gray-700 font-semibold px-4 py-2 rounded-lg shadow-sm text-sm flex items-center gap-2 transition-all">
              <Folder size={16} className="text-yellow-600" />
              Wybierz Folder
              <input
                type="file"
                webkitdirectory="true"
                directory=""
                className="hidden"
                disabled={isProcessing}
                onChange={handleFileSelection}
              />
            </label>
          </div>
        </div>

        {files.length > 0 && (
          <div className="p-4 bg-gray-100 rounded-xl border border-gray-200">
            <div className="flex justify-between items-center mb-2">
              <p className="font-bold text-gray-800">
                Kolejka ({files.length} plików):
              </p>
              <button
                onClick={() => setFiles([])}
                disabled={isProcessing}
                className="text-xs text-red-600 hover:underline font-semibold"
              >
                Wyczyść listę
              </button>
            </div>
            <ul className="max-h-40 overflow-y-auto text-sm text-gray-600 space-y-1 pr-1">
              {files.map((f, idx) => (
                <li key={idx} className="flex justify-between items-center bg-white p-2 rounded border border-gray-200 truncate">
                  <span className="truncate flex-1 font-mono text-xs">• {f.name} ({(f.size / 1024 / 1024).toFixed(2)} MB)</span>
                  {!isProcessing && (
                    <button onClick={() => removeFile(idx)} className="text-gray-400 hover:text-red-600 ml-2">
                      <X size={14} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button
          onClick={handleBatchSave}
          disabled={isProcessing || (files.length === 0 && !title && !content)}
          className="p-4 bg-black text-white font-bold text-lg rounded-xl hover:bg-gray-800 transition-colors disabled:bg-gray-400 flex items-center justify-center gap-2 shadow-md"
        >
          {isProcessing ? (
            <>
              <RefreshCw className="animate-spin" size={20} />
              Analizowanie... ({stats.current}/{stats.total})
            </>
          ) : (
            'Uruchom Analizę i Zapis w Pamięci AI'
          )}
        </button>

        {status && (
          <div
            className={`mt-2 font-bold text-center text-base p-4 rounded-lg border whitespace-pre-wrap ${
              status.includes('❌') || status.includes('⚠️')
                ? 'bg-red-50 text-red-800 border-red-200'
                : status.includes('🎉') || status.includes('✅')
                ? 'bg-green-50 text-green-800 border-green-200'
                : 'bg-white text-gray-800 border-gray-200 shadow-sm'
            }`}
          >
            {status}
          </div>
        )}
      </div>
    </div>
  );
}