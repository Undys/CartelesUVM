require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// Servir archivos estáticos del frontend
app.use(express.static(path.join(__dirname, 'public')));

// Cliente de Supabase Storage
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Multer en memoria para enviar directamente el PDF a Supabase Storage
const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') cb(null, true);
        else cb(new Error('Solo se permiten archivos PDF'));
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Helper para convertir nombres y apellidos a Title Case
function capitalizarNombre(str) {
    if (!str) return '';
    return str.replace(/\b([a-záéíóúñü])([a-záéíóúñü]*)/gi, (m, primera, resto) => {
        return primera.toUpperCase() + resto.toLowerCase();
    });
}

// Helper para convertir nombres de alumnos a MAYÚSCULAS COMPLETAS
function convertirMayusculas(str) {
    if (!str) return '';
    return str.trim().toUpperCase();
}

// Helper para generar claves únicas de carteles
function generarClaveAleatoria() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let codigo = '';
    for (let i = 0; i < 4; i++) {
        codigo += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `CART-${codigo}`;
}

let pool;
async function conectarBD() {
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 4000,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME || 'test',
        ssl: { rejectUnauthorized: false }, // Requerido por TiDB Cloud
        waitForConnections: true,
        connectionLimit: 10
    });
    console.log('✅ Conectado exitosamente a TiDB Cloud');

    try {
        // Asegurar tablas iniciales si aún no existen
        await pool.query(`
            CREATE TABLE IF NOT EXISTS profesores (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(250) NOT NULL,
                carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería',
                nivel_asignado INT DEFAULT 1,
                password VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS carteles (
                id INT AUTO_INCREMENT PRIMARY KEY,
                usuario_id INT NULL,
                nombre_equipo VARCHAR(250) NULL,
                participantes TEXT NULL,
                carrera VARCHAR(100) NOT NULL,
                semestre INT NOT NULL,
                nivel INT NOT NULL,
                titulo_cartel VARCHAR(255) NOT NULL,
                clave VARCHAR(50) NULL,
                archivo_url TEXT NULL,
                profesor_asesor_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS asignaciones (
                id INT AUTO_INCREMENT PRIMARY KEY,
                cartel_id INT NOT NULL,
                profesor_id INT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS evaluaciones (
                id INT AUTO_INCREMENT PRIMARY KEY,
                cartel_id INT NOT NULL,
                profesor_id INT NOT NULL,
                r1 INT NOT NULL,
                r2 INT NOT NULL,
                r3 INT NOT NULL,
                r4 INT NOT NULL,
                r5 INT DEFAULT 0,
                puntaje_total INT GENERATED ALWAYS AS (r1 + r2 + r3 + r4 + r5) STORED,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS administradores (
                id INT AUTO_INCREMENT PRIMARY KEY,
                usuario VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        // 1. Columna carrera en profesores
        const [pCols] = await pool.query("SHOW COLUMNS FROM profesores LIKE 'carrera'");
        if (pCols.length === 0) {
            await pool.query("ALTER TABLE profesores ADD COLUMN carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería' AFTER nombre");
        }

        // 2. Columna participantes en carteles
        const [cPart] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'participantes'");
        if (cPart.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN participantes TEXT NULL AFTER nombre_equipo");
        }

        // 3. Columna clave en carteles
        const [cClave] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'clave'");
        if (cClave.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN clave VARCHAR(50) NULL AFTER titulo_cartel");
        }

        // 4. Asegurar claves y participantes en carteles existentes
        const [existentes] = await pool.query("SELECT id, nombre_equipo, clave, participantes FROM carteles");
        for (const c of existentes) {
            const nuevaClave = c.clave || generarClaveAleatoria();
            const nuevosPart = (c.participantes || c.nombre_equipo || '').toUpperCase();
            await pool.query("UPDATE carteles SET clave = ?, participantes = ? WHERE id = ?", [nuevaClave, nuevosPart, c.id]);
        }

        // 5. Tabla general de usuarios
        await pool.query(`
            CREATE TABLE IF NOT EXISTS usuarios (
                id INT AUTO_INCREMENT PRIMARY KEY,
                nombre VARCHAR(250) NOT NULL,
                matricula VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                rol ENUM('estudiante', 'profesor', 'admin') NOT NULL DEFAULT 'estudiante',
                carrera VARCHAR(100) NOT NULL DEFAULT 'Ingeniería',
                semestre INT DEFAULT 1,
                nivel_asignado INT DEFAULT 1,
                profesor_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        `);

        // 6. Columna usuario_id en carteles
        const [uCols] = await pool.query("SHOW COLUMNS FROM carteles LIKE 'usuario_id'");
        if (uCols.length === 0) {
            await pool.query("ALTER TABLE carteles ADD COLUMN usuario_id INT NULL AFTER id");
        }

        // 7. Sincronizar profesores en usuarios
        const [todosProfes] = await pool.query("SELECT * FROM profesores");
        for (const p of todosProfes) {
            const mat = 'prof_' + p.id;
            const [uExist] = await pool.query("SELECT id FROM usuarios WHERE profesor_id = ? OR matricula = ?", [p.id, mat]);
            if (uExist.length === 0) {
                await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), mat, p.password || '123456', p.carrera || 'Ingeniería', p.nivel_asignado || 1, p.id]
                );
            }
        }

        // 8. Asegurar usuario admin general
        const [admExist] = await pool.query("SELECT id FROM usuarios WHERE matricula = 'admin'");
        if (admExist.length === 0) {
            await pool.query(
                "INSERT INTO usuarios (nombre, matricula, password, rol, carrera, nivel_asignado) VALUES ('ADMINISTRADOR GENERAL', 'admin', 'admin123', 'admin', 'General', 1)"
            );
        }

        console.log('✅ Esquema y tablas actualizados en TiDB Cloud.');
    } catch (e) {
        console.warn('Verificación de esquema BD:', e.message);
    }
}
conectarBD();

// --- ENDPOINTS AUTENTICACIÓN Y GESTIÓN DE USUARIOS ---

app.post('/api/registro', async (req, res) => {
    try {
        const { nombre, matricula, password, carrera, semestre } = req.body;
        if (!nombre || !matricula || !password) {
            return res.status(400).json({ error: "Nombre completo, matrícula/usuario y contraseña son obligatorios." });
        }

        const nombreMayus = convertirMayusculas(nombre);
        const mat = matricula.trim();
        const pass = password.trim();
        const carreraVal = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const semVal = parseInt(semestre) || 1;

        const [existente] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [mat]);
        if (existente.length > 0) {
            return res.status(400).json({ error: "Esa matrícula o usuario ya se encuentra registrado." });
        }

        const [result] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, password, rol, carrera, semestre) VALUES (?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, pass, 'estudiante', carreraVal, semVal]
        );

        res.json({
            mensaje: `¡Estudiante ${nombreMayus} registrado con éxito!`,
            usuario: {
                id: result.insertId,
                nombre: nombreMayus,
                matricula: mat,
                rol: 'estudiante',
                carrera: carreraVal,
                semestre: semVal
            }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const idf = (req.body.usuario || req.body.identificador || req.body.matricula || '').trim();
        const pass = (req.body.password || '').trim();

        if (!idf || !pass) {
            return res.status(400).json({ error: "Ingresa tu usuario/matrícula y contraseña." });
        }

        const [rows] = await pool.query(
            'SELECT id, nombre, matricula, password, rol, carrera, semestre, nivel_asignado, profesor_id FROM usuarios WHERE (LOWER(TRIM(matricula)) = LOWER(?) OR LOWER(TRIM(nombre)) = LOWER(?))',
            [idf, idf]
        );

        if (rows.length > 0 && rows[0].password === pass) {
            const u = rows[0];
            delete u.password;
            return res.json({ mensaje: "Acceso correcto", usuario: u });
        }

        const [admins] = await pool.query('SELECT * FROM administradores WHERE usuario = ? AND password = ?', [idf, pass]);
        if (admins.length > 0) {
            return res.json({
                mensaje: "Acceso concedido como Administrador",
                usuario: {
                    id: admins[0].id,
                    nombre: 'ADMINISTRADOR GENERAL',
                    matricula: admins[0].usuario,
                    rol: 'admin',
                    carrera: 'General'
                }
            });
        }

        const [profes] = await pool.query(
            'SELECT id, nombre, carrera, nivel_asignado, password FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(?) OR id = ?) AND password = ?',
            [idf, isNaN(idf) ? -1 : parseInt(idf), pass]
        );

        if (profes.length > 0) {
            const p = profes[0];
            const [uCheck] = await pool.query('SELECT id, rol FROM usuarios WHERE profesor_id = ?', [p.id]);
            let uId = uCheck.length > 0 ? uCheck[0].id : null;
            if (!uId) {
                const [ins] = await pool.query(
                    "INSERT INTO usuarios (nombre, matricula, password, rol, carrera, nivel_asignado, profesor_id) VALUES (?, ?, ?, 'profesor', ?, ?, ?)",
                    [p.nombre.toUpperCase(), `prof_${p.id}`, pass, p.carrera, p.nivel_asignado, p.id]
                );
                uId = ins.insertId;
            }
            return res.json({
                mensaje: "Acceso concedido como Profesor Juez",
                usuario: {
                    id: uId,
                    nombre: p.nombre.toUpperCase(),
                    matricula: `prof_${p.id}`,
                    rol: 'profesor',
                    carrera: p.carrera,
                    nivel_asignado: p.nivel_asignado,
                    profesor_id: p.id
                }
            });
        }

        return res.status(401).json({ error: "Matrícula/Usuario o contraseña incorrectos." });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/estudiantes/:id/carteles', async (req, res) => {
    try {
        const usuarioId = req.params.id;
        const [uRows] = await pool.query('SELECT id, nombre FROM usuarios WHERE id = ?', [usuarioId]);
        const nombreU = uRows.length > 0 ? uRows[0].nombre : '';

        const query = `
            SELECT 
                c.id, c.titulo_cartel, c.clave, c.nombre_equipo, c.participantes, c.carrera, c.semestre, c.nivel, c.archivo_url,
                COUNT(e.id) as num_evaluaciones,
                ROUND(AVG(e.puntaje_total), 2) as promedio_final,
                ROUND(AVG(e.puntaje_total) / 4.0, 2) as promedio_estrellas,
                (SELECT nombre FROM profesores p WHERE p.id = c.profesor_asesor_id) as asesor_nombre
            FROM carteles c
            LEFT JOIN evaluaciones e ON c.id = e.cartel_id
            WHERE c.usuario_id = ? OR (c.participantes IS NOT NULL AND UPPER(c.participantes) LIKE ?)
            GROUP BY c.id
            ORDER BY c.id DESC
        `;
        const [rows] = await pool.query(query, [usuarioId, `%${nombreU}%`]);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/admin/usuarios', async (req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT id, nombre, matricula, rol, carrera, semestre, nivel_asignado, profesor_id, created_at
            FROM usuarios
            ORDER BY 
                CASE rol WHEN 'admin' THEN 1 WHEN 'profesor' THEN 2 ELSE 3 END,
                nombre ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/admin/usuarios', async (req, res) => {
    try {
        const { nombre, matricula, password, rol, carrera, semestre, nivel_asignado } = req.body;
        if (!nombre || !matricula || !password) {
            return res.status(400).json({ error: "Nombre, usuario/matrícula y contraseña son obligatorios." });
        }

        const nombreMayus = convertirMayusculas(nombre);
        const mat = matricula.trim();
        const rolVal = (rol === 'profesor' || rol === 'admin') ? rol : 'estudiante';
        const carreraVal = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const semVal = parseInt(semestre) || 1;
        const nivelVal = parseInt(nivel_asignado) || 1;

        const [existente] = await pool.query('SELECT id FROM usuarios WHERE LOWER(TRIM(matricula)) = LOWER(?)', [mat]);
        if (existente.length > 0) {
            return res.status(400).json({ error: "Esa matrícula o usuario ya existe." });
        }

        let profId = null;
        if (rolVal === 'profesor') {
            const [pIns] = await pool.query(
                'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)',
                [nombreMayus, carreraVal, nivelVal, password]
            );
            profId = pIns.insertId;
        }

        const [uIns] = await pool.query(
            'INSERT INTO usuarios (nombre, matricula, password, rol, carrera, semestre, nivel_asignado, profesor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [nombreMayus, mat, password, rolVal, carreraVal, semVal, nivelVal, profId]
        );

        res.json({
            mensaje: `Usuario ${nombreMayus} registrado como ${rolVal} exitosamente.`,
            usuario: { id: uIns.insertId, nombre: nombreMayus, matricula: mat, rol: rolVal, carrera: carreraVal, nivel_asignado: nivelVal, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/admin/usuarios/:id/rol', async (req, res) => {
    try {
        const { id } = req.params;
        const { rol, carrera, nivel_asignado } = req.body;

        const [userRows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (userRows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
        const user = userRows[0];

        const nuevoRol = rol || 'estudiante';
        const nuevaCarrera = carrera || user.carrera || 'Ingeniería';
        const nuevoNivel = parseInt(nivel_asignado) || user.nivel_asignado || 1;

        let profId = user.profesor_id;

        if (nuevoRol === 'profesor') {
            if (!profId) {
                const [pIns] = await pool.query(
                    'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)',
                    [user.nombre, nuevaCarrera, nuevoNivel, user.password || '123456']
                );
                profId = pIns.insertId;
            } else {
                await pool.query(
                    'UPDATE profesores SET carrera = ?, nivel_asignado = ? WHERE id = ?',
                    [nuevaCarrera, nuevoNivel, profId]
                );
            }
        }

        await pool.query(
            'UPDATE usuarios SET rol = ?, carrera = ?, nivel_asignado = ?, profesor_id = ? WHERE id = ?',
            [nuevoRol, nuevaCarrera, nuevoNivel, profId, id]
        );

        res.json({
            mensaje: `¡Usuario ${user.nombre} ahora tiene el rol de ${nuevoRol.toUpperCase()}!`,
            usuario: { ...user, rol: nuevoRol, carrera: nuevaCarrera, nivel_asignado: nuevoNivel, profesor_id: profId }
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/admin/usuarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, matricula, carrera, semestre, nivel_asignado, password } = req.body;

        const [userRows] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (userRows.length === 0) return res.status(404).json({ error: "Usuario no encontrado." });
        const user = userRows[0];

        const nombreMayus = nombre ? convertirMayusculas(nombre) : user.nombre;
        const mat = matricula ? matricula.trim() : user.matricula;
        const car = carrera || user.carrera;
        const sem = semestre !== undefined ? parseInt(semestre) : user.semestre;
        const niv = nivel_asignado !== undefined ? parseInt(nivel_asignado) : user.nivel_asignado;
        const pass = password ? password.trim() : user.password;

        await pool.query(
            'UPDATE usuarios SET nombre = ?, matricula = ?, carrera = ?, semestre = ?, nivel_asignado = ?, password = ? WHERE id = ?',
            [nombreMayus, mat, car, sem, niv, pass, id]
        );

        if (user.profesor_id) {
            await pool.query(
                'UPDATE profesores SET nombre = ?, carrera = ?, nivel_asignado = ?, password = ? WHERE id = ?',
                [nombreMayus, car, niv, pass, user.profesor_id]
            );
        }

        res.json({ mensaje: "Usuario actualizado correctamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/admin/usuarios/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [u] = await pool.query('SELECT * FROM usuarios WHERE id = ?', [id]);
        if (u.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

        if (u[0].profesor_id) {
            const [asigs] = await pool.query('SELECT id FROM asignaciones WHERE profesor_id = ?', [u[0].profesor_id]);
            const [evals] = await pool.query('SELECT id FROM evaluaciones WHERE profesor_id = ?', [u[0].profesor_id]);
            if (asigs.length > 0 || evals.length > 0) {
                return res.status(400).json({ error: "No se puede eliminar porque este profesor ya tiene asignaciones o evaluaciones registradas." });
            }
            await pool.query('DELETE FROM profesores WHERE id = ?', [u[0].profesor_id]);
        }

        await pool.query('DELETE FROM usuarios WHERE id = ?', [id]);
        res.json({ mensaje: "Usuario eliminado exitosamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- ENDPOINTS ADMINISTRADOR ---

app.post('/api/admin/login', async (req, res) => {
    try {
        const { usuario, password } = req.body;
        const [rows] = await pool.query('SELECT * FROM administradores WHERE usuario = ? AND password = ?', [usuario, password]);
        if (rows.length === 0) return res.status(401).json({ error: "Credenciales de administrador incorrectas" });
        res.json({ mensaje: "Acceso concedido", admin: rows[0].usuario });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/profesores/:id/nivel', async (req, res) => {
    try {
        const { id } = req.params;
        const { nivel_asignado } = req.body;
        await pool.query('UPDATE profesores SET nivel_asignado = ? WHERE id = ?', [parseInt(nivel_asignado), id]);
        res.json({ mensaje: "Nivel de profesor actualizado correctamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.put('/api/profesores/:id/carrera', async (req, res) => {
    try {
        const { id } = req.params;
        const { carrera } = req.body;
        await pool.query('UPDATE profesores SET carrera = ? WHERE id = ?', [carrera, id]);
        res.json({ mensaje: "Área de profesor actualizada correctamente" });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/profesores/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;

        await connection.execute('DELETE FROM asignaciones WHERE profesor_id = ?', [id]);
        await connection.execute('DELETE FROM evaluaciones WHERE profesor_id = ?', [id]);
        await connection.execute('UPDATE carteles SET profesor_asesor_id = NULL WHERE profesor_asesor_id = ?', [id]);
        await connection.execute('DELETE FROM profesores WHERE id = ?', [id]);

        await connection.commit();
        res.json({ mensaje: "Profesor eliminado exitosamente" });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.get('/api/admin/metricas', async (req, res) => {
    try {
        const [[carteles]] = await pool.query('SELECT COUNT(*) as total FROM carteles');
        const [[profesores]] = await pool.query('SELECT COUNT(*) as total FROM profesores');
        const [[evaluaciones]] = await pool.query('SELECT COUNT(*) as total FROM evaluaciones');
        const [[estudiantes]] = await pool.query("SELECT COUNT(*) as total FROM usuarios WHERE rol = 'estudiante'");
        res.json({ carteles: carteles.total, profesores: profesores.total, estudiantes: estudiantes.total, evaluaciones: evaluaciones.total });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- ENDPOINTS PROFESORES Y JUECES ---

app.get('/api/profesores', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, nombre, carrera, nivel_asignado FROM profesores ORDER BY nombre ASC');
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/profesores', async (req, res) => {
    try {
        const { nombre, carrera, nivel_asignado, password } = req.body;
        if (!nombre || !password) {
            return res.status(400).json({ error: "El nombre y la contraseña son obligatorios" });
        }
        const nombreCap = capitalizarNombre(nombre.trim());
        const areaCarrera = (carrera && carrera.trim()) ? carrera.trim() : 'Ingeniería';
        const nivelAleatorio = Math.floor(Math.random() * 3) + 1;
        const nivel = (nivel_asignado !== undefined && nivel_asignado !== null && nivel_asignado !== '') 
            ? parseInt(nivel_asignado) 
            : nivelAleatorio;

        const query = 'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)';
        const [result] = await pool.query(query, [nombreCap, areaCarrera, nivel, password]);
        res.json({ id: result.insertId, mensaje: `Profesor ${nombreCap} registrado con éxito en ${areaCarrera} (Asignado aleatoriamente a Nivel ${nivel}).` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/admin/profesores/randomizar-niveles', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [profesores] = await connection.execute('SELECT id, carrera FROM profesores');
        
        if (profesores.length === 0) {
            await connection.rollback();
            return res.status(400).json({ error: "No hay profesores registrados para asignar niveles." });
        }

        const porArea = {};
        profesores.forEach(p => {
            const area = p.carrera || 'General';
            if (!porArea[area]) porArea[area] = [];
            porArea[area].push(p.id);
        });

        for (const area in porArea) {
            const ids = porArea[area];
            for (let i = ids.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [ids[i], ids[j]] = [ids[j], ids[i]];
            }
            for (let i = 0; i < ids.length; i++) {
                const nuevoNivel = (i % 3) + 1;
                await connection.execute('UPDATE profesores SET nivel_asignado = ? WHERE id = ?', [nuevoNivel, ids[i]]);
            }
        }

        await connection.commit();
        res.json({ mensaje: `¡Se asignaron y balancearon aleatoriamente los niveles para ${profesores.length} profesor(es) por área!` });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.post('/api/login/profesor', async (req, res) => {
    try {
        const usuario = req.body.usuario || req.body.nombre || req.body.profesor_id;
        const password = req.body.password;

        if (!usuario || !password) {
            return res.status(400).json({ error: "Por favor ingresa usuario y contraseña" });
        }

        const idParam = isNaN(usuario) ? -1 : parseInt(usuario);
        const [rows] = await pool.query(
            'SELECT id, nombre, carrera, nivel_asignado FROM profesores WHERE (LOWER(TRIM(nombre)) = LOWER(TRIM(?)) OR id = ?) AND password = ?', 
            [usuario, idParam, password]
        );

        if (rows.length === 0) return res.status(401).json({ error: "Contraseña incorrecta o usuario no encontrado" });
        res.json(rows[0]);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// --- CARTELES, CLAVES Y EVALUACIONES (CON SUPABASE STORAGE) ---

app.get('/api/admin/carteles', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id, c.titulo_cartel, c.clave, c.nombre_equipo, c.participantes, c.carrera, c.semestre, c.nivel, c.archivo_url,
                COUNT(e.id) as num_evaluaciones,
                (SELECT nombre FROM profesores p WHERE p.id = c.profesor_asesor_id) as asesor_nombre
            FROM carteles c
            LEFT JOIN evaluaciones e ON c.id = e.cartel_id
            GROUP BY c.id
            ORDER BY c.id DESC
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/carteles/clave/:clave', async (req, res) => {
    try {
        const clave = (req.params.clave || '').trim();
        if (!clave) return res.status(400).json({ error: "Por favor proporciona la clave del cartel." });

        const [carteles] = await pool.query(
            `SELECT c.*, 
                    (SELECT COUNT(*) FROM evaluaciones e WHERE e.cartel_id = c.id) as total_evaluaciones,
                    (SELECT nombre FROM profesores p WHERE p.id = c.profesor_asesor_id) as asesor_nombre
             FROM carteles c
             WHERE LOWER(TRIM(c.clave)) = LOWER(TRIM(?))`,
            [clave]
        );

        if (carteles.length === 0) {
            return res.status(404).json({ error: "No se encontró ningún cartel con esa clave de acceso." });
        }

        const cartel = carteles[0];

        const [asignados] = await pool.query(
            `SELECT p.id, p.nombre, p.carrera,
                    CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END as ya_evaluo
             FROM asignaciones a
             JOIN profesores p ON a.profesor_id = p.id
             LEFT JOIN evaluaciones e ON (e.cartel_id = a.cartel_id AND e.profesor_id = a.profesor_id)
             WHERE a.cartel_id = ?`,
            [cartel.id]
        );

        res.json({
            cartel,
            asignados,
            puede_evaluar: cartel.total_evaluaciones < 3
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.delete('/api/carteles/:id', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { id } = req.params;

        const [[cartel]] = await connection.execute('SELECT archivo_url FROM carteles WHERE id = ?', [id]);
        if (!cartel) {
            await connection.rollback();
            return res.status(404).json({ error: "Cartel no encontrado" });
        }

        await connection.execute('DELETE FROM asignaciones WHERE cartel_id = ?', [id]);
        await connection.execute('DELETE FROM evaluaciones WHERE cartel_id = ?', [id]);
        await connection.execute('DELETE FROM carteles WHERE id = ?', [id]);

        await connection.commit();

        // Borrar archivo de Supabase Storage si existe
        if (cartel.archivo_url) {
            const fileName = cartel.archivo_url.split('/').pop();
            if (fileName) {
                await supabase.storage.from('carteles-uvm').remove([fileName]);
            }
        }

        res.json({ mensaje: "Cartel y evaluaciones eliminados correctamente" });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.delete('/api/admin/carteles/todos', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [carteles] = await connection.execute('SELECT archivo_url FROM carteles');

        await connection.execute('DELETE FROM asignaciones');
        await connection.execute('DELETE FROM evaluaciones');
        await connection.execute('DELETE FROM carteles');

        await connection.commit();

        // Eliminar archivos de Supabase Storage
        const fileNames = carteles
            .map(c => c.archivo_url ? c.archivo_url.split('/').pop() : null)
            .filter(Boolean);

        if (fileNames.length > 0) {
            await supabase.storage.from('carteles-uvm').remove(fileNames);
        }

        res.json({ mensaje: `Se eliminaron ${carteles.length} carteles y se limpiaron todas sus asignaciones y evaluaciones.` });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

// SUBIR CARTEL A SUPABASE STORAGE E INSERTAR EN TIDB CLOUD
app.post('/api/carteles', upload.single('archivo_pdf'), async (req, res) => {
    try {
        const { nombre_equipo, participantes, carrera, semestre, titulo_cartel, profesor_asesor_id, usuario_id } = req.body;
        let archivo_url = '';

        if (req.file) {
            const ext = path.extname(req.file.originalname) || '.pdf';
            const fileName = `cartel_${Date.now()}_${Math.round(Math.random() * 1E9)}${ext}`;

            const { data, error: storageError } = await supabase.storage
                .from('carteles-uvm')
                .upload(fileName, req.file.buffer, {
                    contentType: req.file.mimetype
                });

            if (storageError) throw storageError;

            const { data: publicUrlData } = supabase.storage
                .from('carteles-uvm')
                .getPublicUrl(fileName);

            archivo_url = publicUrlData.publicUrl;
        }

        const sem = parseInt(semestre);
        let nivel = 1;
        if (sem >= 4 && sem <= 6) nivel = 2;
        if (sem >= 7) nivel = 3;

        const equipoCap = capitalizarNombre((nombre_equipo || '').trim());
        const participantesMayus = convertirMayusculas((participantes || '').trim());
        const tituloLimpio = (titulo_cartel || '').trim();
        const usrId = usuario_id ? parseInt(usuario_id) : null;

        let claveGenerada = generarClaveAleatoria();
        let existeClave = true;
        while (existeClave) {
            const [existentes] = await pool.query('SELECT id FROM carteles WHERE clave = ?', [claveGenerada]);
            if (existentes.length === 0) {
                existeClave = false;
            } else {
                claveGenerada = generarClaveAleatoria();
            }
        }

        const query = `INSERT INTO carteles (usuario_id, nombre_equipo, participantes, carrera, semestre, nivel, titulo_cartel, clave, archivo_url, profesor_asesor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await pool.query(query, [usrId, equipoCap, participantesMayus, carrera, sem, nivel, tituloLimpio, claveGenerada, archivo_url, profesor_asesor_id || null]);

        res.json({ 
            id: result.insertId, 
            clave: claveGenerada,
            mensaje: `Cartel registrado con éxito en Nivel ${nivel}. Clave única asignada: ${claveGenerada}` 
        });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message });
    }
});

async function ejecutarRepartoCarteles(req, res) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.execute('DELETE FROM asignaciones');

        const [carteles] = await connection.execute('SELECT id, titulo_cartel, nivel, carrera, profesor_asesor_id FROM carteles');
        const [profesores] = await connection.execute('SELECT id, nombre, nivel_asignado, carrera FROM profesores');

        if (carteles.length === 0) {
            await connection.rollback();
            return res.status(400).json({ error: "No hay carteles registrados para repartir." });
        }

        const cargaProfesores = {};
        profesores.forEach(p => cargaProfesores[p.id] = 0);

        for (const cartel of carteles) {
            const candidatosValidos = profesores.filter(p => 
                Number(p.nivel_asignado) === Number(cartel.nivel) &&
                p.carrera && cartel.carrera &&
                p.carrera.trim().toLowerCase() === cartel.carrera.trim().toLowerCase() &&
                p.id !== cartel.profesor_asesor_id
            );

            if (candidatosValidos.length < 3) {
                throw new Error(
                    `El cartel "${cartel.titulo_cartel}" (Área: ${cartel.carrera}, Nivel ${cartel.nivel}) requiere mínimo 3 profesores jueces de su misma área y nivel. Disponibles actualmente: ${candidatosValidos.length}. Asigna o registra más profesores de ${cartel.carrera} en Nivel ${cartel.nivel}.`
                );
            }

            candidatosValidos.sort((a, b) => cargaProfesores[a.id] - cargaProfesores[b.id]);
            const asignados = candidatosValidos.slice(0, 3);

            for (const profe of asignados) {
                await connection.execute('INSERT INTO asignaciones (cartel_id, profesor_id) VALUES (?, ?)', [cartel.id, profe.id]);
                cargaProfesores[profe.id]++;
            }
        }

        await connection.commit();
        res.json({ mensaje: "¡Carteles repartidos exitosamente entre los profesores jueces!" });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
}

app.post('/api/admin/repartir-carteles', ejecutarRepartoCarteles);
app.post('/api/admin/cerrar-y-asignar', ejecutarRepartoCarteles);

app.get('/api/profesores/:profesor_id/carteles-asignados', async (req, res) => {
    try {
        const { profesor_id } = req.params;
        const query = `
            SELECT c.*, 
                   (SELECT COUNT(*) FROM evaluaciones e2 WHERE e2.cartel_id = c.id) as total_evaluaciones
            FROM asignaciones a
            JOIN carteles c ON a.cartel_id = c.id
            LEFT JOIN evaluaciones e ON (e.cartel_id = c.id AND e.profesor_id = a.profesor_id)
            WHERE a.profesor_id = ? AND e.id IS NULL
        `;
        const [rows] = await pool.query(query, [profesor_id]);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/evaluar', async (req, res) => {
    try {
        const { cartel_id, profesor_id, r1, r2, r3, r4 } = req.body;

        const valR1 = parseInt(r1);
        const valR2 = parseInt(r2);
        const valR3 = parseInt(r3);
        const valR4 = parseInt(r4);

        if ([valR1, valR2, valR3, valR4].some(v => isNaN(v) || v < 1 || v > 5)) {
            return res.status(400).json({ error: "Todos los rubros (Originalidad, Estética, Exposición y Vestimenta) deben calificarse con estrellas de 1 a 5." });
        }

        const [conteo] = await pool.query(`SELECT COUNT(*) as total FROM evaluaciones WHERE cartel_id = ?`, [cartel_id]);
        if (conteo[0].total >= 3) {
            return res.status(400).json({ error: "Este cartel ya cuenta con sus 3 evaluaciones completadas." });
        }

        const query = `INSERT INTO evaluaciones (cartel_id, profesor_id, r1, r2, r3, r4, r5) VALUES (?, ?, ?, ?, ?, ?, 0)`;
        await pool.query(query, [cartel_id, profesor_id, valR1, valR2, valR3, valR4]);

        res.json({ mensaje: "Evaluación registrada con éxito" });
    } catch (err) {
        res.status(400).json({ error: "Error o ya habías evaluado este cartel." });
    }
});

app.post('/api/evaluar-invitado', async (req, res) => {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const { clave, nombre_maestro, suplir_profesor_id, r1, r2, r3, r4 } = req.body;

        if (!clave || !nombre_maestro || !nombre_maestro.trim()) {
            await connection.rollback();
            return res.status(400).json({ error: "La clave del cartel y tu nombre como Maestro Invitado son requeridos." });
        }

        const valR1 = parseInt(r1);
        const valR2 = parseInt(r2);
        const valR3 = parseInt(r3);
        const valR4 = parseInt(r4);

        if ([valR1, valR2, valR3, valR4].some(v => isNaN(v) || v < 1 || v > 5)) {
            await connection.rollback();
            return res.status(400).json({ error: "Todos los rubros deben calificarse de 1 a 5 estrellas." });
        }

        const [carteles] = await connection.execute(
            'SELECT id, nivel, carrera, titulo_cartel FROM carteles WHERE LOWER(TRIM(clave)) = LOWER(TRIM(?))',
            [clave.trim()]
        );
        if (carteles.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: "No se encontró ningún cartel con esa clave." });
        }
        const cartel = carteles[0];

        const [[conteo]] = await connection.execute('SELECT COUNT(*) as total FROM evaluaciones WHERE cartel_id = ?', [cartel.id]);
        if (conteo.total >= 3) {
            await connection.rollback();
            return res.status(400).json({ error: "Este cartel ya cuenta con sus 3 evaluaciones completadas." });
        }

        const nombreFormateado = capitalizarNombre(nombre_maestro.trim());

        let profesorId;
        const [existentes] = await connection.execute(
            'SELECT id FROM profesores WHERE LOWER(TRIM(nombre)) = LOWER(TRIM(?))',
            [nombreFormateado]
        );
        if (existentes.length > 0) {
            profesorId = existentes[0].id;
        } else {
            const [nuevoProfe] = await connection.execute(
                'INSERT INTO profesores (nombre, carrera, nivel_asignado, password) VALUES (?, ?, ?, ?)',
                [nombreFormateado, cartel.carrera || 'General', cartel.nivel || 1, 'invitado123']
            );
            profesorId = nuevoProfe.insertId;
        }

        const [yaEvaluado] = await connection.execute(
            'SELECT id FROM evaluaciones WHERE cartel_id = ? AND profesor_id = ?',
            [cartel.id, profesorId]
        );
        if (yaEvaluado.length > 0) {
            await connection.rollback();
            return res.status(400).json({ error: `El maestro ${nombreFormateado} ya registró una calificación previa para este cartel.` });
        }

        if (suplir_profesor_id) {
            await connection.execute(
                'UPDATE asignaciones SET profesor_id = ? WHERE cartel_id = ? AND profesor_id = ?',
                [profesorId, cartel.id, parseInt(suplir_profesor_id)]
            );
        } else {
            const [asigCheck] = await connection.execute(
                'SELECT id FROM asignaciones WHERE cartel_id = ? AND profesor_id = ?',
                [cartel.id, profesorId]
            );
            if (asigCheck.length === 0) {
                await connection.execute(
                    'INSERT INTO asignaciones (cartel_id, profesor_id) VALUES (?, ?)',
                    [cartel.id, profesorId]
                );
            }
        }

        await connection.execute(
            'INSERT INTO evaluaciones (cartel_id, profesor_id, r1, r2, r3, r4, r5) VALUES (?, ?, ?, ?, ?, ?, 0)',
            [cartel.id, profesorId, valR1, valR2, valR3, valR4]
        );

        await connection.commit();
        res.json({ 
            mensaje: `¡Evaluación registrada exitosamente por ${nombreFormateado}!`,
            cartel_id: cartel.id
        });
    } catch (err) {
        await connection.rollback();
        res.status(400).json({ error: err.message });
    } finally {
        connection.release();
    }
});

app.get('/api/dashboard/ranking', async (req, res) => {
    try {
        const query = `
            SELECT 
                c.id, c.titulo_cartel, c.clave, c.nombre_equipo, c.participantes, c.nivel, c.carrera, c.archivo_url,
                COUNT(e.id) as num_evaluaciones,
                ROUND(AVG(e.puntaje_total), 2) as promedio_final,
                ROUND(AVG(e.puntaje_total) / 4.0, 2) as promedio_estrellas
            FROM carteles c
            LEFT JOIN evaluaciones e ON c.id = e.cartel_id
            GROUP BY c.id
            ORDER BY c.nivel ASC, promedio_final DESC
        `;
        const [rows] = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));