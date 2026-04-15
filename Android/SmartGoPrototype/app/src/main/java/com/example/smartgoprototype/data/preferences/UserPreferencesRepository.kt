package com.example.smartgoprototype.data.preferences

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

data class UserPreferences(
    val notificationsEnabled: Boolean = false,
    val gpsTrackingEnabled: Boolean = false
)

@Singleton
class UserPreferencesRepository @Inject constructor(
    private val dataStore: DataStore<Preferences>
) {
    companion object {
        private val NOTIFICATIONS_ENABLED = booleanPreferencesKey("notifications_enabled")
        private val GPS_TRACKING_ENABLED  = booleanPreferencesKey("gps_tracking_enabled")
    }

    val userPreferences: Flow<UserPreferences> = dataStore.data
        .catch { emit(emptyPreferences()) }
        .map { prefs ->
            UserPreferences(
                notificationsEnabled = prefs[NOTIFICATIONS_ENABLED] ?: false,
                gpsTrackingEnabled   = prefs[GPS_TRACKING_ENABLED]  ?: false
            )
        }

    suspend fun setNotificationsEnabled(enabled: Boolean) {
        dataStore.edit { it[NOTIFICATIONS_ENABLED] = enabled }
    }

    suspend fun setGpsTrackingEnabled(enabled: Boolean) {
        dataStore.edit { it[GPS_TRACKING_ENABLED] = enabled }
    }
}
