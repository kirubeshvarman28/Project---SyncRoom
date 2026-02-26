import os
import random
import string
import threading
import time
from datetime import datetime, timedelta

from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, send_from_directory, session
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from werkzeug.utils import secure_filename
import uuid

from models import db, User, Room, FileItem, RoomMember

app = Flask(__name__)
app.config['SECRET_KEY'] = os.urandom(24)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///saladroom.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['UPLOAD_FOLDER'] = 'uploads'
# app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # Limit removed

db.init_app(app)
login_manager = LoginManager()
login_manager.login_view = 'login'
login_manager.init_app(app)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# --- HELPERS ---

def generate_room_code():
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not Room.query.filter_by(code=code).first():
            return code

def cleanup_expired_files():
    """Background task to delete files based on their custom expiry."""
    with app.app_context():
        while True:
            try:
                now = datetime.utcnow()
                # Fetch all files that are NOT permanent (-1)
                temp_files = FileItem.query.filter(FileItem.expiry_minutes != -1).all()
                
                deleted_count = 0
                for file in temp_files:
                    expiry_time = file.upload_date + timedelta(minutes=file.expiry_minutes)
                    if now > expiry_time:
                        if os.path.exists(file.file_path):
                            try:
                                os.remove(file.file_path)
                                room_dir = os.path.dirname(file.file_path)
                                if os.path.exists(room_dir) and not os.listdir(room_dir):
                                    os.rmdir(room_dir)
                            except Exception as e:
                                print(f"Error removing file {file.file_path}: {e}")
                        db.session.delete(file)
                        deleted_count += 1
                
                if deleted_count > 0:
                    db.session.commit()
                    print(f"Cleaned up {deleted_count} expired files.")

                # Cleanup stale members (older than 30 seconds)
                stale_cutoff = datetime.utcnow() - timedelta(seconds=30)
                stale_members = RoomMember.query.filter(RoomMember.last_seen < stale_cutoff).all()
                if stale_members:
                    for member in stale_members:
                        db.session.delete(member)
                    db.session.commit()
                    print(f"Cleaned up {len(stale_members)} stale members.")
            except Exception as e:
                print(f"Cleanup error: {e}")
            time.sleep(30)

# --- AUTH ROUTES ---

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        username = request.form.get('username')
        email = request.form.get('email')
        password = request.form.get('password')
        
        if User.query.filter_by(username=username).first() or User.query.filter_by(email=email).first():
            flash('Username or Email already exists.', 'danger')
            return redirect(url_for('register'))
            
        new_user = User(username=username, email=email)
        new_user.set_password(password)
        db.session.add(new_user)
        db.session.commit()
        flash('Registration successful! Please login.', 'success')
        return redirect(url_for('login'))
        
    return render_template('register.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        email = request.form.get('email')
        password = request.form.get('password')
        user = User.query.filter_by(email=email).first()
        
        if user and user.check_password(password):
            login_user(user)
            return redirect(request.args.get('next') or url_for('index'))
        else:
            flash('Invalid email or password.', 'danger')
            
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# --- CORE APP ROUTES ---

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/create-room', methods=['POST'])
def create_room():
    code = generate_room_code()
    new_room = Room(code=code)
    db.session.add(new_room)
    db.session.commit()
    return redirect(url_for('room', code=code))

@app.route('/room/<code>')
def room(code):
    room = Room.query.filter_by(code=code).first()
    if not room:
        flash("Room not found or expired.", "error")
        return redirect(url_for('index'))
    
    # Register/Update member session
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
    
    member = RoomMember.query.filter_by(session_id=session['session_id'], room_id=room.id).first()
    if not member:
        member = RoomMember(session_id=session['session_id'], room_id=room.id)
        db.session.add(member)
    else:
        member.last_seen = datetime.utcnow()
    
    db.session.commit()
    return render_template('room.html', room=room)

@app.route('/api/check_room/<code>')
def check_room(code):
    room = Room.query.filter_by(code=code).first()
    return jsonify({"exists": room is not None})

@app.route('/api/room/<code>/heartbeat', methods=['POST'])
def heartbeat(code):
    room = Room.query.filter_by(code=code).first_or_404()
    
    if 'session_id' in session:
        member = RoomMember.query.filter_by(session_id=session['session_id'], room_id=room.id).first()
        if member:
            member.last_seen = datetime.utcnow()
            db.session.commit()
    
    # Count active members in this room (seen in last 15 seconds)
    active_cutoff = datetime.utcnow() - timedelta(seconds=15)
    member_count = RoomMember.query.filter(
        RoomMember.room_id == room.id,
        RoomMember.last_seen > active_cutoff
    ).count()
    
    return jsonify({'member_count': max(1, member_count)})

@app.route('/api/room/<code>/upload', methods=['POST'])
def upload_file(code):
    room = Room.query.filter_by(code=code).first_or_404()
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    
    files = request.files.getlist('file')
    if not files or files[0].filename == '':
        return jsonify({'error': 'No selected files'}), 400
    
    expiry = int(request.form.get('expiry', 5))
    uploaded_filenames = []
    
    for file in files:
        if file:
            filename = secure_filename(file.filename)
            room_dir = os.path.join(app.config['UPLOAD_FOLDER'], code)
            os.makedirs(room_dir, exist_ok=True)
            
            file_path = os.path.join(room_dir, filename)
            file.save(file_path)
            
            new_file = FileItem(
                filename=filename,
                file_path=file_path,
                room_id=room.id,
                expiry_minutes=expiry
            )
            db.session.add(new_file)
            uploaded_filenames.append(filename)
    
    db.session.commit()
    return jsonify({
        'message': f'{len(uploaded_filenames)} files uploaded successfully', 
        'filenames': uploaded_filenames
    })

@app.route('/api/room/<code>/delete/<filename>', methods=['POST'])
def delete_file(code, filename):
    room = Room.query.filter_by(code=code).first_or_404()
    file_item = FileItem.query.filter_by(room_id=room.id, filename=filename).first_or_404()
    
    # Delete from disk
    if os.path.exists(file_item.file_path):
        try:
            os.remove(file_item.file_path)
            # Remove room directory if empty
            room_dir = os.path.dirname(file_item.file_path)
            if os.path.exists(room_dir) and not os.listdir(room_dir):
                os.rmdir(room_dir)
        except Exception as e:
            print(f"Error removing file {file_item.file_path}: {e}")
            return jsonify({'error': 'Could not delete file from disk'}), 500
            
    # Delete from database
    db.session.delete(file_item)
    db.session.commit()
    
    return jsonify({'message': 'File deleted successfully'})

@app.route('/api/room/<code>/files')
def get_room_files(code):
    room = Room.query.filter_by(code=code).first_or_404()
    files_data = []
    for file in room.files:
        files_data.append({
            'filename': file.filename,
            'upload_date': file.upload_date.isoformat(),
            'expiry_minutes': file.expiry_minutes,
            'download_url': url_for('download_file', code=code, filename=file.filename)
        })
    return jsonify({'files': files_data})

@app.route('/download/<code>/<filename>')
def download_file(code, filename):
    room_dir = os.path.join(app.config['UPLOAD_FOLDER'], code)
    return send_from_directory(room_dir, filename)

if __name__ == '__main__':
    with app.app_context():
        db.create_all()
    
    # Start cleanup thread
    cleanup_thread = threading.Thread(target=cleanup_expired_files, daemon=True)
    cleanup_thread.start()
    
    # Support LAN sharing via host="0.0.0.0"
    # use_reloader=False is important when using background threads to avoid duplicates
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
