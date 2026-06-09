import { getPageImage, source } from '@/lib/source';
import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';

export const revalidate = false;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  const logoUrl = new URL('/logo.png', req.url).toString();
  const markUrl = new URL('/rabbit-white.svg', req.url).toString();

  return new ImageResponse(
    (
      // react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style -- next/og renders through Satori; external CSS classes are not available in generated image markup.
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          overflow: 'hidden',
          background: '#f8f6ee',
          color: '#282c25',
          fontFamily: 'Inter, Arial, sans-serif',
        }}
      >
        {/* react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style -- next/og renders through Satori; external CSS classes are not available in generated image markup. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'radial-gradient(circle at 18% 18%, rgba(208,111,37,0.26), transparent 270px), radial-gradient(circle at 88% 18%, rgba(140,199,190,0.32), transparent 320px)',
          }}
        />
        <img
          src={logoUrl}
          alt=""
          width={640}
          height={640}
          style={{
            position: 'absolute',
            right: -72,
            bottom: -148,
            opacity: 0.12,
          }}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            width: '100%',
            padding: 72,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            {/* react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style -- next/og renders through Satori; external CSS classes are not available in generated image markup. */}
            <div
              style={{
                width: 58,
                height: 58,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 18,
                background: '#434e3f',
                boxShadow: '0 18px 60px rgba(67,78,63,0.18)',
              }}
            >
              <img src={markUrl} alt="Matrix OS" width={34} height={34} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 28, fontWeight: 700 }}>Matrix OS</div>
              <div
                style={{
                  color: '#d06f25',
                  fontSize: 18,
                  fontWeight: 700,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                }}
              >
                Documentation
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {/* react-doctor-disable-next-line react-doctor/no-inline-exhaustive-style -- next/og renders through Satori; external CSS classes are not available in generated image markup. */}
            <div
              style={{
                alignSelf: 'flex-start',
                border: '1px solid rgba(67,78,63,0.16)',
                borderRadius: 999,
                background: 'rgba(255,255,255,0.72)',
                padding: '10px 18px',
                color: '#434e3f',
                fontSize: 20,
                fontWeight: 700,
              }}
            >
              AI operating system
            </div>
            <div
              style={{
                maxWidth: 870,
                fontSize: 72,
                lineHeight: 0.96,
                fontWeight: 800,
                letterSpacing: -1.6,
              }}
            >
              {page.data.title}
            </div>
            <div
              style={{
                maxWidth: 820,
                color: '#5f6358',
                fontSize: 28,
                lineHeight: 1.35,
              }}
            >
              {page.data.description}
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              color: '#6e6a5f',
              fontSize: 22,
            }}
          >
            <div>matrix-os.com/docs</div>
            <div style={{ color: '#d06f25', fontWeight: 700 }}>
              files, apps, agents, memory
            </div>
          </div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: getPageImage(page).segments,
  }));
}
