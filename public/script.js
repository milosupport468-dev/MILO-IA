const API_URL = "";

const app = {
    currentPage: "dashboard",
    selectedServer: null,
    user: null
};

const pages = {
    dashboard: "Inicio",
    servers: "Mis servidores",
    ai: "Inteligencia artificial",
    tickets: "Tickets",
    moderation: "Moderación",
    automations: "Automatizaciones",
    analytics: "Estadísticas",
    premium: "Premium",
    account: "Mi cuenta",
    settings: "Configuración"
};

function navigate(page) {
    if (!pages[page]) return;

    app.currentPage = page;

    document.querySelectorAll("[data-page]").forEach(element => {
        element.classList.toggle(
            "active",
            element.dataset.page === page
        );
    });

    document.dispatchEvent(
        new CustomEvent("milo:navigate", {
            detail: { page }
        })
    );
}

async function request(endpoint, options = {}) {
    const response = await fetch(`${API_URL}/api${endpoint}`, {
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...options.headers
        },
        ...options
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "Error en la solicitud");
    }

    return data;
}

async function loadUser() {
    try {
        app.user = await request("/user");
        document.dispatchEvent(
            new CustomEvent("milo:user-loaded", {
                detail: app.user
            })
        );
    } catch (error) {
        console.error("No se pudo cargar el usuario:", error);
    }
}

async function loadServers() {
    try {
        const data = await request("/servers");

        document.dispatchEvent(
            new CustomEvent("milo:servers-loaded", {
                detail: data
            })
        );
    } catch (error) {
        console.error("No se pudieron cargar los servidores:", error);
    }
}

async function sendMessage(message) {
    if (!message.trim()) return;

    try {
        return await request("/ai/chat", {
            method: "POST",
            body: JSON.stringify({ message })
        });
    } catch (error) {
        console.error("Error de IA:", error);
        throw error;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    loadUser();
    loadServers();

    document.querySelectorAll("[data-page]").forEach(element => {
        element.addEventListener("click", () => {
            navigate(element.dataset.page);
        });
    });
});
