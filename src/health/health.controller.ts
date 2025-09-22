/* eslint-disable prettier/prettier */
import { Controller, Get } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';

@Controller('health')
export class HealthController {
  constructor(private firebaseService: FirebaseService) {}

  @Get()
  checkHealth() {
    const firebaseReady = this.firebaseService.isReady();
    const error = this.firebaseService.getInitializationError();
    
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      firebase: {
        ready: firebaseReady,
        error: error?.message || null,
      },
      environment: {
        nodeEnv: process.env.NODE_ENV,
        renderService: process.env.RENDER_SERVICE_NAME || 'local',
        hasFirebaseConfig: {
          projectId: !!process.env.FIREBASE_PROJECT_ID,
          clientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: !!process.env.FIREBASE_PRIVATE_KEY,
        }
      }
    };
  }

  @Get('firebase')
  async checkFirebase() {
    try {
      if (!this.firebaseService.isReady()) {
        return {
          status: 'error',
          message: 'Firebase not initialized',
          error: this.firebaseService.getInitializationError()?.message
        };
      }

      // Test FCM
      //const messaging = this.firebaseService.getMessaging();
      
      return {
        status: 'ok',
        firebase: {
          ready: true,
          messaging: 'available',
          timestamp: new Date().toISOString()
        }
      };
      
    } catch (error) {
      return {
        status: 'error',
        message: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}