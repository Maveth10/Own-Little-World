'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';
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
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');

  const handleSave = async () => {
    if (!title && !content && !file) {
      setStatus('❌ Musisz dodać chociaż notatkę, tytuł lub plik!');
      return;
    }

    try {
      let fileUrl = null;
      let fileName = '';
      let fileType = '';

      if (file) {
        setStatus('⏳ Wysyłanie pliku do magazynu Supabase Storage...');
        const supabase = getSupabase();
        const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, '');
        fileName = `${Date.now()}_${safeName}`;
        fileType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');

        // Wysyłka bezpośrednio z przeglądarki do Supabase (Ominięcie limitu 4.5MB Vercela)
        const { error: uploadError } = await supabase.storage
          .from('schematy')
          .upload(fileName, file, { contentType: fileType, upsert: true });

        if (uploadError) {
          throw new Error(`Błąd wgrywania pliku do Supabase: ${uploadError.message}`);
        }

        fileUrl = supabase.storage.from('schematy').getPublicUrl(fileName).data.publicUrl;
      }

      setStatus('⏳ Przetwarzanie dokumentu przez AI (Analiza i wektoryzacja)...');

      // Przesłanie lekkiego ładunku JSON do Vercel API
      const res = await fetch('/api/teach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          content,
          fileUrl,
          fileName: file ? file.name : '',
          fileType
        }),
      });

      const data = await res.json();

      if (data.success) {
        setStatus(`✅ Sukces! ${data.message}`);
        setTitle('');
        setContent('');
        setFile(null);
      } else {
        setStatus('❌ Błąd API: ' + data.error);
      }
    } catch (error: any) {
      console.error(error);
      setStatus('❌ Błąd: ' + (error.message || 'Problem z połączeniem.'));
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto font-sans">
      <h1 className="text-3xl font-bold mb-2">Panel Głównego Inżyniera</h1>
      <p className="text-gray-600 mb-8">
        Wgraj dokumentację PDF lub zdjęcie. AI przeanalizuje treść, podzieli dane i wygeneruje punkty odniesienia.
      </p>

      <div className="flex flex-col gap-5">
        <input
          type="text"
          placeholder="Tytuł (opcjonalnie)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-yellow-400 outline-none"
        />

        <textarea
          placeholder="Notatki / uwagi serwisowe (opcjonalnie)..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg h-40 focus:ring-2 focus:ring-yellow-400 outline-none"
        />

        <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100 transition-colors">
          <Upload className="text-gray-400 mb-3" size={36} />
          <label className="cursor-pointer text-yellow-600 font-bold hover:underline text-lg">
            Wybierz plik (PDF lub Obraz)
            <input
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          {file && (
            <p className="text-md text-green-600 font-bold mt-4 break-all text-center">
              Wybrano: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
            </p>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={!title && !content && !file}
          className="p-4 bg-black text-white font-bold text-lg rounded-xl hover:bg-gray-800 transition-colors disabled:bg-gray-400"
        >
          Przeanalizuj i Zapisz w Pamięci AI
        </button>

        {status && (
          <div className={`mt-4 font-bold text-center text-lg p-4 rounded-lg border ${status.includes('❌') ? 'bg-red-50 text-red-800 border-red-200' : 'bg-white text-gray-800 border-gray-100'}`}>
            {status}
          </div>
        )}
      </div>
    </div>
  );
}