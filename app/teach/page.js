'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';

export default function TeachAI() {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');

  const handleSave = async () => {
    if (!title && !content && !file) {
      setStatus('❌ Musisz dodać chociaż notatkę lub plik!');
      return;
    }

    setStatus(
      '⏳ Przetwarzanie: Wgrywanie pliku, wektoryzacja i zapisywanie...'
    );

    try {
      // Przygotowujemy dane do wysłania w tle
      const formData = new FormData();
      formData.append('title', title);
      formData.append('content', content);
      if (file) formData.append('file', file);

      const res = await fetch('/api/teach', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();

      if (data.success) {
        setStatus('✅ Sukces! Baza wektorowa została zaktualizowana.');
        setTitle('');
        setContent('');
        setFile(null);
      } else {
        setStatus('❌ Błąd: ' + data.error);
      }
    } catch (error) {
      setStatus('❌ Błąd połączenia z serwerem AI.');
    }
  };

  return (
    <div className="p-8 max-w-2xl mx-auto font-sans">
      <h1 className="text-3xl font-bold mb-2">Panel Głównego Inżyniera</h1>
      <p className="text-gray-600 mb-8">
        Zautomatyzowane wgrywanie schematów i wektoryzacja wiedzy dla AI.
      </p>

      <div className="flex flex-col gap-5">
        <input
          type="text"
          placeholder="Tytuł / Nazwa elementu (np. Stycznik UFC 300)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-yellow-400 outline-none transition-all"
        />

        <textarea
          placeholder="Pełna instrukcja (słowa kluczowe, procedury serwisowe, parametry zasilania...)"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="p-3 border border-gray-300 rounded-lg h-40 focus:ring-2 focus:ring-yellow-400 outline-none transition-all"
        />

        <div className="border-2 border-dashed border-gray-300 rounded-xl p-8 flex flex-col items-center justify-center bg-gray-50 hover:bg-gray-100 transition-colors">
          <Upload className="text-gray-400 mb-3" size={36} />
          <label className="cursor-pointer text-yellow-600 font-bold hover:underline text-lg">
            Wybierz plik PDF lub zdjęcie schematu
            <input
              type="file"
              className="hidden"
              onChange={(e) => setFile(e.target.files[0])}
            />
          </label>
          <p className="text-sm text-gray-500 mt-2">
            Plik zostanie automatycznie oczyszczony i wgrany do chmury
          </p>
          {file && (
            <p className="text-md text-green-600 font-bold mt-4">
              Pomyślnie wybrano: {file.name}
            </p>
          )}
        </div>

        <button
          onClick={handleSave}
          className="p-4 bg-black text-white font-bold text-lg rounded-xl hover:bg-gray-800 transition-colors shadow-lg"
        >
          Zapisz w Pamięci AI
        </button>

        {status && (
          <div className="mt-4 font-bold text-center text-lg text-gray-800 bg-white p-4 rounded-lg shadow-sm">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
