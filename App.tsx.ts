import { useState, useEffect } from 'react';
import { QRScanner } from './components/QRScanner';
import { EmployeeDisplay } from './components/EmployeeDisplay';
import { ReportesPanel } from './components/ReportesPanel';
import { AdminLogin } from './components/AdminLogin';
import { SucursalLogin } from './components/SucursalLogin';
import { Settings } from 'lucide-react';
import { ActiveBreakBanner, type DescansoInfo } from './components/ActiveBreakBanner';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { projectId, publicAnonKey } from '/utils/supabase/info';
import {
  registrarAsistencia,
  inicializarDatos,
  obtenerEmpleado,
  buscarEmpleadoPorNombre,
  obtenerAsistenciasEmpleado,
  type Sucursal,
} from '../lib/api';
import { toast, Toaster } from 'sonner';

const supabase = createClient(`https://${projectId}.supabase.co`, publicAnonKey);

const CICLO: Array<'entrada' | 'descanso1_inicio' | 'descanso1_fin' | 'descanso2_inicio' | 'descanso2_fin' | 'salida'> = [
  'entrada',
  'descanso1_inicio',
  'descanso1_fin',
  'descanso2_inicio',
  'descanso2_fin',
  'salida',
];

const LABELS: Record<string, string> = {
  entrada:          'ENTRADA',
  descanso1_inicio: 'INICIO DESCANSO 1 (20 min)',
  descanso1_fin:    'FIN DESCANSO 1',
  descanso2_inicio: 'INICIO DESCANSO 2 (10 min)',
  descanso2_fin:    'FIN DESCANSO 2',
  salida:           'SALIDA',
};

export default function App() {
  const [currentTime, setCurrentTime] = useState(new Date());
  const [sucursalActiva, setSucursalActiva] = useState<Sucursal | null>(null);
  const [checkedEmployee, setCheckedEmployee] = useState<{
    name: string;
    id: string;
    timestamp: Date;
    type: string;
    label: string;
  } | null>(null);
  const [showReportes, setShowReportes] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const [showAdminLogin, setShowAdminLogin] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [clickCount, setClickCount] = useState(0);

  // Estado del descanso activo (persistente y sin marca antigua)
  const [descansoActivo, setDescansoActivo] = useState<DescansoInfo | null>(() => {
    try {
      const guardado = localStorage.getItem('cai_descanso_activo');
      return guardado ? JSON.parse(guardado) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (clickCount > 0) {
      const timer = setTimeout(() => setClickCount(0), 2000);
      return () => clearTimeout(timer);
    }
  }, [clickCount]);

  const handleLogoClick = () => {
    const newCount = clickCount + 1;
    setClickCount(newCount);
    if (newCount === 5) {
      setShowAdminLogin(true);
      setClickCount(0);
    }
  };

  const handleAdminLogin = () => {
    setIsAdmin(true);
    setShowAdminLogin(false);
    setShowReportes(true);
    toast.success('Acceso administrativo concedido', {
      style: { background: '#18181b', color: '#fff', border: '1px solid #dc2626' }
    });
  };

  const handleAdminLogout = () => {
    setIsAdmin(false);
    setShowReportes(false);
    toast.info('Sesión administrativa cerrada');
  };

  const handleSucursalLogin = (sucursal: Sucursal) => {
    setSucursalActiva(sucursal);
    toast.success(`Bienvenido — ${sucursal.nombre}`);
  };

  const handleSucursalLogout = () => {
    setSucursalActiva(null);
    setIsAdmin(false);
    setShowReportes(false);
  };

  useEffect(() => {
    const initData = async () => {
      const result = await inicializarDatos();
      if (result.success) setIsInitialized(true);
    };
    if (!isInitialized) initData();
  }, [isInitialized]);

  const [bloqueados, setBloqueados] = useState<Record<string, number>>({});

  const handleCheckIn = async (qrData: string) => {
    try {
      const esNombre = qrData.includes(' ');
      const empleadoResult = esNombre
        ? await buscarEmpleadoPorNombre(qrData)
        : await obtenerEmpleado(qrData);

      if (!empleadoResult.success || !empleadoResult.data) {
        toast.error(`Empleado no encontrado: ${qrData.substring(0, 30)}`);
        return;
      }

      const empleado = empleadoResult.data;

      const ahora = Date.now();
      if (bloqueados[empleado.id] && ahora - bloqueados[empleado.id] < 60000) {
        const restante = Math.ceil((30000 - (ahora - bloqueados[empleado.id])) / 1000);
        toast.warning(`${empleado.nombre} ya checó. Espera ${restante}s.`);
        return;
      }
      setBloqueados(prev => ({ ...prev, [empleado.id]: ahora }));

      const asistenciasResult = await obtenerAsistenciasEmpleado(empleado.id);
      const hoy = new Date().toLocaleDateString('es-MX');
      const registrosHoy = (asistenciasResult.data ?? [])
        .filter(a => a.fecha === hoy)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      const ultimoTipo = registrosHoy.at(-1)?.tipo ?? null;

      let siguienteTipo: typeof CICLO[number];

      if (!ultimoTipo) {
        siguienteTipo = 'entrada';
      } else {
        const indiceActual = CICLO.indexOf(ultimoTipo as typeof CICLO[number]);
        if (indiceActual === -1 || indiceActual === CICLO.length - 1) {
          siguienteTipo = 'entrada';
        } else {
          siguienteTipo = CICLO[indiceActual + 1];
        }
      }

      // Regla: No más de una persona en descanso a la vez
      if (
        (siguienteTipo === 'descanso1_inicio' || siguienteTipo === 'descanso2_inicio') &&
        descansoActivo &&
        descansoActivo.nombre !== empleado.nombre
      ) {
        toast.error(`No puedes iniciar descanso: ${descansoActivo.nombre} aún está en descanso.`);
        return;
      }

      const asistenciaResult = await registrarAsistencia(
        empleado.id,
        siguienteTipo as any,
        sucursalActiva?.id
      );

      if (!asistenciaResult.success) {
        toast.error('Error al registrar asistencia');
        return;
      }

      // ── CONTROL DEL CRONÓMETRO REGRESIVO ──
      if (siguienteTipo === 'descanso1_inicio' || siguienteTipo === 'descanso2_inicio') {
        const duracionMin = siguienteTipo === 'descanso1_inicio' ? 20 : 10;
        const nuevoDescanso: DescansoInfo = {
          nombre: empleado.nombre,
          inicioIso: new Date().toISOString(),
          duracionMin,
        };
        setDescansoActivo(nuevoDescanso);
        localStorage.setItem('cai_descanso_activo', JSON.stringify(nuevoDescanso));
      } else if (
        siguienteTipo === 'descanso1_fin' ||
        siguienteTipo === 'descanso2_fin' ||
        siguienteTipo === 'salida'
      ) {
        setDescansoActivo(null);
        localStorage.removeItem('cai_descanso_activo');
      }

      const label = LABELS[siguienteTipo] ?? siguienteTipo.toUpperCase();

      setCheckedEmployee({
        name: empleado.nombre,
        id: empleado.id,
        timestamp: new Date(),
        type: siguienteTipo,
        label,
      });

      toast.success(`${label}: ${empleado.nombre}`, {
        style: { background: '#18181b', color: '#fff', border: '1px solid #10b981' }
      });
      setTimeout(() => setCheckedEmployee(null), 5000);

    } catch (error) {
      console.error('Error en handleCheckIn:', error);
      toast.error('Error al procesar el registro');
    }
  };

  if (!sucursalActiva) {
    return (
      <>
        <Toaster position="top-right" />
        <SucursalLogin onLogin={handleSucursalLogin} />
      </>
    );
  }

  return (
    <>
      <Toaster position="top-right" />
      {/* Fondo blanco puro con texto carbón */}
      <div className="size-full bg-white text-zinc-950 overflow-hidden relative flex flex-col font-sans antialiased">
        
        {/* Header - Estilo Terminal / Consola */}
        <div className="relative border-b-4 border-red-600 bg-zinc-950 text-white shrink-0">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between px-4 md:px-8 py-3 md:py-4 gap-4">
            
            <div onClick={handleLogoClick} className="cursor-pointer select-none">
              <h1 className="tracking-tight text-white text-2xl md:text-3xl font-black leading-none">
                CONTROL DE ASISTENCIA
              </h1>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="w-2 h-2 rounded-full bg-red-600 animate-pulse"></span>
                <p className="tracking-widest text-red-500 font-bold text-xs uppercase">
                  {sucursalActiva.nombre}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {isAdmin && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowReportes(!showReportes)}
                    className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 font-bold tracking-wider text-xs flex items-center gap-1.5 transition border-2 border-red-600"
                  >
                    <Settings className="size-4" />
                    <span>{showReportes ? 'MODO CHECADOR' : 'PANEL ADMIN'}</span>
                  </button>
                  <button
                    onClick={handleAdminLogout}
                    className="bg-zinc-800 hover:bg-zinc-700 text-white px-3 py-1.5 font-bold tracking-wider text-xs transition border-2 border-zinc-800"
                  >
                    SALIR
                  </button>
                </div>
              )}
              <button
                onClick={handleSucursalLogout}
                className="text-xs text-zinc-400 hover:text-white uppercase tracking-wider transition font-bold"
              >
                CERRAR SUCURSAL
              </button>
              
              <div className="text-right pl-4 border-l border-zinc-800">
                <div className="text-2xl md:text-3xl font-black font-mono text-white leading-none">
                  {currentTime.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              </div>
            </div>
          </div>
          
          {/* Línea decorativa roja y negra (tipo cinta de precaución) */}
          <div className="h-1.5 flex">
            {Array.from({ length: 40 }).map((_, i) => (
              <div key={i} className={i % 2 === 0 ? 'flex-1 bg-red-600' : 'flex-1 bg-zinc-950'} />
            ))}
          </div>
        </div>

        {/* Layout Principal */}
        <div className="relative flex-1 min-h-0 p-4 md:p-6 overflow-hidden bg-zinc-50">
          {showReportes ? (
            <div className="size-full overflow-auto bg-white border-2 border-zinc-950 rounded-xl shadow-sm">
              <ReportesPanel />
            </div>
          ) : (
            <div className="size-full max-w-6xl mx-auto flex flex-col md:flex-row gap-6 items-stretch justify-center">
              
              {/* Lado izquierdo: Cámara / QR Scanner */}
              <div className="flex-1 flex flex-col min-h-0 bg-white border-2 border-zinc-950 rounded-xl p-4 shadow-[4px_4px_0px_0px_#18181b]">
                <div className="w-full flex-1 flex items-center justify-center overflow-hidden bg-zinc-100 rounded-lg border border-zinc-200 relative">
                  {/* Etiqueta flotante de la cámara */}
                  <div className="absolute top-3 left-3 z-10 bg-zinc-950 text-white text-[10px] font-bold px-2 py-1 uppercase tracking-widest rounded-md flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 bg-red-600 rounded-full animate-pulse"></div>
                    Lector Activo
                  </div>
                  
                  <QRScanner onScan={handleCheckIn} />
                </div>
              </div>

              {/* Lado derecho: Cronómetro Arriba + Registro Abajo */}
              <div className="w-full md:w-[420px] flex flex-col gap-6 min-h-0 justify-between">
                
                {/* 1. Cronómetro / Monitor Permanente */}
                <div className="shrink-0">
                  <ActiveBreakBanner descanso={descansoActivo} />
                </div>

                {/* 2. Tarjeta del empleado */}
                <div className="flex-1 min-h-[260px] bg-white border-2 border-zinc-950 rounded-xl p-5 flex flex-col justify-between shadow-[4px_4px_0px_0px_#18181b]">
                  <span className="text-[11px] font-black text-zinc-500 uppercase tracking-widest block border-b-2 border-zinc-100 pb-2">
                    ÚLTIMO REGISTRO PROCESADO
                  </span>
                  <div className="flex-1 flex items-center justify-center mt-4">
                    <EmployeeDisplay employee={checkedEmployee} />
                  </div>
                </div>

              </div>

            </div>
          )}
        </div>

        {showAdminLogin && (
          <AdminLogin onLogin={handleAdminLogin} onClose={() => setShowAdminLogin(false)} />
        )}
      </div>
    </>
  );
}