
import React, { useEffect, useRef } from 'react';

interface CloudBackgroundProps {
    mode: 'gradient' | 'dark';
}

const CloudBackground: React.FC<CloudBackgroundProps> = ({ mode }) => {


    const isDay = mode === 'gradient';
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const cloudSons = containerRef.current?.querySelectorAll('.cloud-son') as NodeListOf<HTMLElement>;
        if (!cloudSons) return;

        const getRandomDirection = () => {
            const directions = ["20px", "-20px", "10px", "-10px", "0px"];
            return directions[Math.floor(Math.random() * directions.length)];
        };

        const moveElementRandomly = (element: HTMLElement) => {
            const randomDirectionX = getRandomDirection();
            const randomDirectionY = getRandomDirection();
            element.style.transform = `translate(${randomDirectionX}, ${randomDirectionY})`;
        };

        // Initial wiggle
        cloudSons.forEach(moveElementRandomly);

        const interval = setInterval(() => {
            cloudSons.forEach(moveElementRandomly);
        }, 2000); // 2 seconds interval

        return () => clearInterval(interval);
    }, []);

    // Root container (Static, handles z-index and positioning)
    const rootStyle: React.CSSProperties = {
        position: 'fixed',
        bottom: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 1,
        overflow: 'hidden',
    };

    // Cloud Wrapper (Handles Cloud-specific enter/exit animation)
    const cloudWrapperStyle: React.CSSProperties = {
        position: 'absolute',
        width: '100%',
        height: '100%',
        transform: isDay ? 'translateY(10%)' : 'translateY(100%)', // Clouds fly down in night
        transition: 'transform 1.0s cubic-bezier(0.56, 1.1, 0.52, 1.00)',
        opacity: isDay ? 1 : 0.5,
    };

    const cloudSonCommon: React.CSSProperties = {
        position: 'absolute',
        backgroundColor: '#fff',
        borderRadius: '50%',
        transition: 'transform 6s ease-in-out', // The wiggle transition
    };



    return (
        <div ref={containerRef} style={rootStyle}>

            <div className="cloud-wrapper" style={cloudWrapperStyle}>
                <div className="cloud-cluster-right" style={{ position: 'absolute', bottom: 0, right: 0, width: '1000px', height: '600px' }}>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '-10%', bottom: '0%', width: '400px', height: '400px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '5%', bottom: '-20%', width: '500px', height: '500px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '30%', bottom: '-30%', width: '500px', height: '500px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '55%', bottom: '-25%', width: '450px', height: '450px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '75%', bottom: '-45%', width: '550px', height: '550px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '100%', bottom: '-35%', width: '450px', height: '450px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '10%', bottom: '-400px', width: '800px', height: '600px' }}></div>
                </div>


                <div className="cloud-cluster-left" style={{ position: 'absolute', bottom: 0, left: '-200px', width: '800px', height: '500px', opacity: 0.8, zIndex: -1 }}>
                    <div className="cloud-son" style={{ ...cloudSonCommon, left: '0%', bottom: '0%', width: '350px', height: '350px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, left: '20%', bottom: '-20%', width: '400px', height: '400px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, left: '45%', bottom: '-15%', width: '380px', height: '380px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, left: '70%', bottom: '-30%', width: '420px', height: '420px' }}></div>
                    <div className="cloud-son" style={{ ...cloudSonCommon, left: '20%', bottom: '-350px', width: '600px', height: '500px' }}></div>
                </div>

                <div className="cloud-light" style={{
                    position: 'absolute',
                    bottom: '50px',
                    right: '10%',
                    width: '100%',
                    height: '100%',
                    zIndex: -2,
                    opacity: 0.6
                }}>
                    <div className="cloud-son" style={{ ...cloudSonCommon, right: '-30%', bottom: '-25%', width: '750px', height: '750px' }}></div>
                </div>
            </div>



            <div className="stars-container" style={{
                position: 'absolute', // Relative to fixed root
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                zIndex: -5, // Behind clouds to look distant
                pointerEvents: 'none',
                transform: isDay ? 'translateY(-100%)' : 'translateY(0%)',
                transition: 'transform 1.2s cubic-bezier(0.56, 1.1, 0.52, 1.00)', // Matches cloud bounce
                opacity: isDay ? 0 : 1
            }}>
                {/* Generated Stars - Confined to top 40% of screen */}
                <Star top="5%" left="10%" size={3} delay="0s" duration="3s" />
                <Star top="15%" left="80%" size={2} delay="0.5s" duration="4s" />
                <Star top="25%" left="20%" size={4} delay="1s" duration="5s" />
                <Star top="8%" left="50%" size={2} delay="1.5s" duration="3.5s" />
                <Star top="20%" left="90%" size={3} delay="0.2s" duration="4.5s" />
                <Star top="3%" left="70%" size={2} delay="0.8s" duration="3.8s" />
                <Star top="35%" left="60%" size={3} delay="1.2s" duration="4.2s" />
                <Star top="12%" left="30%" size={2} delay="2s" duration="5.5s" />
                <Star top="30%" left="15%" size={4} delay="0.4s" duration="3.2s" />
                <Star top="28%" left="5%" size={2} delay="1.8s" duration="4.8s" />
                <Star top="8%" left="40%" size={3} delay="0.1s" duration="2.5s" />
                <Star top="38%" left="85%" size={2} delay="1.1s" duration="3.9s" />
                <Star top="2%" left="25%" size={3} delay="2.5s" duration="6s" />
                <Star top="18%" left="5%" size={2} delay="3s" duration="5s" />
                <Star top="33%" left="45%" size={3} delay="1.3s" duration="4s" />
            </div>

            <style>{`
                @keyframes twinkle {
                    0%, 20% { transform: scale(0.6); opacity: 0.4; }
                    50% { transform: scale(1.2); opacity: 1; }
                    100% { transform: scale(0.6); opacity: 0.4; }
                }
                .star-wrapper {
                   animation-name: twinkle;
                   animation-iteration-count: infinite;
                   animation-direction: normal;
                   animation-timing-function: ease-in-out;
                }
            `}</style>

        </div>
    );
};

// Helper Component for a Single Star (Simple Circle)
const Star: React.FC<{ top: string, left: string, size: number, delay: string, duration: string }> = ({ top, left, size, delay, duration }) => {
    return (
        <div className="star-wrapper" style={{
            position: 'absolute',
            top,
            left,
            width: size,
            height: size,
            borderRadius: '50%',
            backgroundColor: '#ffffff',
            boxShadow: `0 0 ${size}px #ffffff`, // Small glow
            animationDelay: delay,
            animationDuration: duration
        }}>
        </div>
    );
};

export default CloudBackground;
