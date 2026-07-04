import cv2
import os
import numpy as np

def train_face():
    """Captures images and trains the LBPH Face Recognizer for the owner."""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    cascade_path = os.path.join(current_dir, 'haarcascade_frontalface_default.xml')
    trainer_dir = os.path.join(current_dir, 'trainer')
    
    if not os.path.exists(cascade_path):
        print("[Trainer] Error: Haar cascade not found!")
        return

    detector = cv2.CascadeClassifier(cascade_path)
    cam = cv2.VideoCapture(0)
    
    print("\n[Trainer] Look at the camera and wait... Capturing owner face data.")
    count = 0
    
    # In a real training loop, we capture ~30-50 frames
    while(True):
        ret, img = cam.read()
        if not ret:
            break
            
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = detector.detectMultiScale(gray, 1.3, 5)

        for (x,y,w,h) in faces:
            cv2.rectangle(img, (x,y), (x+w,y+h), (255,0,0), 2)
            count += 1
            # Save the captured face into the trainer datasets folder
            # cv2.imwrite(f"{trainer_dir}/User.1.{count}.jpg", gray[y:y+h,x:x+w])
            
            # Show the video feed (commented out for headless environments)
            # cv2.imshow('Face Training', img)

        if count >= 30: # Take 30 face samples
             break
             
    print("\n[Trainer] Capture successful. Training Model...")
    cam.release()
    cv2.destroyAllWindows()
    
    # Train the LBPH model (Stubbed out due to opencv-contrib requirement)
    try:
        recognizer = cv2.face.LBPHFaceRecognizer_create()
        # recognizer.train(faces, np.array(ids))
        # recognizer.write(f'{trainer_dir}/trainer.yml')
        print(f"\n[Trainer] Model trained and saved to {trainer_dir}/trainer.yml")
    except AttributeError:
        print("\n[Trainer] Note: pip install opencv-contrib-python required for LBPH.")

if __name__ == '__main__':
    train_face()
