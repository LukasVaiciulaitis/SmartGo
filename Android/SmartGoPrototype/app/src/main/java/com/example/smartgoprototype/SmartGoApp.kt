package com.example.smartgoprototype

import android.app.Application
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.util.Log
import com.amplifyframework.AmplifyException
import com.amplifyframework.auth.cognito.AWSCognitoAuthPlugin
import com.amplifyframework.core.Amplify
import com.google.android.libraries.places.api.Places
import dagger.hilt.android.HiltAndroidApp

/**
 * Application entry point.
 *
 * - Enables Hilt dependency injection via [HiltAndroidApp].
 * - Initializes third-party SDKs used app-wide (Amplify/Cognito, Google Places).
 *
 */
@HiltAndroidApp
class SmartGoApp : Application() {

    override fun onCreate() {
        super.onCreate()

        try {
            // Configure Amplify
            Amplify.addPlugin(AWSCognitoAuthPlugin())
            Amplify.configure(applicationContext)
            Log.i("SmartGoApp", "Amplify initialized")
        } catch (error: AmplifyException) {
            Log.e("SmartGoApp", "Could not initialize Amplify", error)
        }

        initPlaces()
    }

    /**
     * Initializes the Google Places SDK (used for origin/destination autocomplete).
     *
     * The API key is read from AndroidManifest meta-data so it can be provided via
     * Gradle secrets
     *
     */
    private fun initPlaces() {
        if (Places.isInitialized()) return

        val apiKey = getApiKeyFromManifest()
        if (apiKey.isNullOrBlank() || apiKey.startsWith("\${")) {
            Log.e(
                "SmartGoApp",
                "Places API key missing or not resolved. Check secrets plugin + manifest placeholder."
            )
            return
        }

        runCatching {
            // Places API initializer (new Places SDK enabled).
            Places.initializeWithNewPlacesApiEnabled(applicationContext, apiKey)
            Log.i("SmartGoApp", "Places initialized")
        }.onFailure { t ->
            Log.e("SmartGoApp", "Places init failed", t)
        }
    }

    /**
     * Reads the Places API key from manifest
     */
    private fun getApiKeyFromManifest(): String? {
        return try {
            val ai: ApplicationInfo =
                packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
            ai.metaData?.getString("com.google.android.geo.API_KEY")
        } catch (e: Exception) {
            Log.e("SmartGoApp", "Failed to read API key meta-data", e)
            null
        }
    }
}
