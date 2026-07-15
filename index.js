const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Minio = require('minio');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(cors());
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================
// 1. KONEKSI & BUCKET MINIO
// ==========================================
const minioClient = new Minio.Client({
    endPoint: 'localhost',
    port: 9010,
    useSSL: false,
    accessKey: 'admin',
    secretKey: 'password123'
});
const BUCKET_NAME = 'google-drive-minio-v2';

// Otomatis mengecek dan membuat bucket jika belum ada
minioClient.bucketExists(BUCKET_NAME, (err, exists) => {
    if (err) {
        console.error("[MinIO Error] Gagal mengecek bucket:", err);
        return;
    }
    if (!exists) {
        minioClient.makeBucket(BUCKET_NAME, 'us-east-1', (makeErr) => {
            if (makeErr) return console.error("[MinIO Error] Gagal membuat bucket:", makeErr);
            console.log(`[MinIO] Bucket '${BUCKET_NAME}' berhasil dibuat otomatis.`);
        });
    } else {
        console.log(`[MinIO] Bucket '${BUCKET_NAME}' sudah siap digunakan.`);
    }
});

// ==========================================
// 2. DATABASE INITIALIZATION
// ==========================================
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("[SQLite Error] Gagal koneksi ke database:", err.message);
    else console.log("[SQLite] Berhasil terkoneksi ke database SQLite.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        parent_id INTEGER DEFAULT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        minio_key TEXT NOT NULL,
        folder_id INTEGER DEFAULT NULL,
        mime_type TEXT
    )`);
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// ==========================================
// 3. API ROUTES
// ==========================================

// [READ] Ambil konten berdasarkan folder_id + Fitur SEARCH
app.get('/api/folders', (req, res) => {
    const parentId = req.query.parentId === 'root' || !req.query.parentId ? null : parseInt(req.query.parentId);
    const search = req.query.search ? `%${req.query.search}%` : null;

    if (search) {
        db.all('SELECT * FROM folders WHERE name LIKE ?', [search], (err, folders) => {
            if (err) return res.status(500).json({ error: err.message });
            db.all('SELECT * FROM files WHERE name LIKE ?', [search], (err, files) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ folders, files });
            });
        });
    } else {
        const folderQuery = parentId ? 'SELECT * FROM folders WHERE parent_id = ?' : 'SELECT * FROM folders WHERE parent_id IS NULL';
        const fileQuery = parentId ? 'SELECT * FROM files WHERE folder_id = ?' : 'SELECT * FROM files WHERE folder_id IS NULL';
        const params = parentId ? [parentId] : [];

        db.all(folderQuery, params, (err, folders) => {
            if (err) return res.status(500).json({ error: err.message });
            db.all(fileQuery, params, (err, files) => {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ folders, files });
            });
        });
    }
});

// [READ] Ambil semua folder untuk keperluan dropdown "Pindah ke..."
app.get('/api/all-folders', (req, res) => {
    db.all('SELECT * FROM folders', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// [READ IMAGE / FILE PREVIEW] Streaming data objek langsung ke browser
app.get('/api/view/:key', (req, res) => {
    const { key } = req.params;
    db.get('SELECT mime_type FROM files WHERE minio_key = ?', [key], (err, row) => {
        if (err || !row) return res.status(404).send('File tidak ditemukan di database');
        
        minioClient.getObject(BUCKET_NAME, key, (minioErr, dataStream) => {
            if (minioErr) return res.status(404).send('Gagal mengambil file dari MinIO Storage');
            res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
            dataStream.pipe(res);
        });
    });
});

// [CREATE] Buat Folder Baru
app.post('/api/folders', (req, res) => {
    const { name, parent_id, parentId } = req.body;
    
    // Validasi input: mendukung penamaan parent_id (snake_case) maupun parentId (camelCase)
    const actualParent = (parent_id === 'root' || parentId === 'root') 
        ? null 
        : (parent_id || parentId || null);

    db.run('INSERT INTO folders (name, parent_id) VALUES (?, ?)', [name, actualParent], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name, parent_id: actualParent });
    });
});

// [CREATE] Upload Banyak File Sekaligus (Multi-user Safe)
app.post('/api/upload', upload.array('files'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "Tidak ada file yang diunggah." });
    }
    const folderId = req.body.folderId && req.body.folderId !== 'null' ? parseInt(req.body.folderId) : null;
    
    try {
        for (let file of req.files) {
            const minioKey = `${Date.now()}-${file.originalname}`;
            await minioClient.putObject(BUCKET_NAME, minioKey, file.buffer, file.size, { 
                'Content-Type': file.mimetype 
            });
            
            db.run('INSERT INTO files (name, minio_key, folder_id, mime_type) VALUES (?, ?, ?, ?)', 
                [file.originalname, minioKey, folderId, file.mimetype]);
        }
        res.json({ message: "Upload berhasil!" });
    } catch (e) { 
        console.error("[Upload Error]:", e);
        res.status(500).json({ error: e.message }); 
    }
});

// [UPDATE] Rename Nama Folder / File
app.put('/api/rename', (req, res) => {
    const { type, id, name } = req.body;
    const table = type === 'folder' ? 'folders' : 'files';
    db.run(`UPDATE ${table} SET name = ? WHERE id = ?`, [name, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Berhasil diubah namanya!" });
    });
});

// [UPDATE] Move/Pindah Item Hirarki (Tuntutan Rubrik CRUD Struktur)
app.put('/api/move', (req, res) => {
    const { type, id, targetFolderId } = req.body;
    const destination = targetFolderId === 'root' ? null : parseInt(targetFolderId);
    
    if (type === 'folder' && destination === id) {
        return res.status(400).json({ error: "Tidak dapat memindahkan folder ke dalam dirinya sendiri!" });
    }

    const query = type === 'folder' 
        ? 'UPDATE folders SET parent_id = ? WHERE id = ?' 
        : 'UPDATE files SET folder_id = ? WHERE id = ?';
        
    db.run(query, [destination, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Berhasil dipindahkan!" });
    });
});

// [DELETE] Hapus Folder
app.delete('/api/folders/:id', (req, res) => {
    const { id } = req.params;
    db.run('DELETE FROM folders WHERE id = ?', [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Folder berhasil dihapus!" });
    });
});

// [DELETE] Hapus File dari SQLite sekaligus Hapus Objek Fisik di MinIO
app.delete('/api/files/:id', (req, res) => {
    const { id } = req.params;
    db.get('SELECT minio_key FROM files WHERE id = ?', [id], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ message: "File tidak ditemukan di database" });
        
        try {
            await minioClient.removeObject(BUCKET_NAME, row.minio_key);
            db.run('DELETE FROM files WHERE id = ?', [id], function(delErr) {
                if (delErr) return res.status(500).json({ error: delErr.message });
                res.json({ message: "File berhasil dihapus permanen!" });
            });
        } catch (e) { 
            console.error("[Delete MinIO Error]:", e);
            res.status(500).json({ error: e.message }); 
        }
    });
});

app.get('/api', (req, res) => {
    res.redirect('/');
});

app.listen(3000, '0.0.0.0', () => {
    console.log('==================================================');
    console.log('Backend Mini Google Drive Berjalan!');
    console.log('Akses Lokal     : http://localhost:3000');
    console.log('Akses Jaringan  : http://10.20.3.232:3000');
    console.log('==================================================');
});